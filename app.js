/* -----------------------------
   Utilitaires
-------------------------------- */
function normalizeKey(s) {
  if (!s) return '';
  return s
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, '')
    .replace(/[^\w]/g, '');
}

function truthy(v) {
  if (v == null) return false;
  const s = normalizeKey(v);
  return ['1','true','yes','oui','y','vrai'].includes(s);
}

function parseFk(raw, sourceColumn) {
  // Accepts formats:
  //  - "Customers.CustomerID"
  //  - "Customers(CustomerID)"
  //  - "CustomerID -> Customers.CustomerID"
  //  - "-> Customers.CustomerID"
  if (!raw) return null;
  const s = String(raw).trim();

  // If contains '->', split and take the RHS
  let rhs = s.includes('->') ? s.split('->').pop().trim() : s;

  // Try "Table(Column)"
  let m = rhs.match(/^\s*([A-Za-z0-9_]+)\s*\(\s*([A-Za-z0-9_]+)\s*\)\s*$/);
  if (m) return { refTable: m[1], refColumn: m[2] };

  // Try "Table.Column"
  m = rhs.match(/^\s*([A-Za-z0-9_]+)\s*\.{1}\s*([A-Za-z0-9_]+)\s*$/);
  if (m) return { refTable: m[1], refColumn: m[2] };

  // If only "Table" was provided, fall back to column name equality
  m = rhs.match(/^\s*([A-Za-z0-9_]+)\s*$/);
  if (m && sourceColumn) return { refTable: m[1], refColumn: sourceColumn };

  return null;
}

function idRel(r) {
  return `${r.fromTable}.${r.fromColumn}__${r.toTable}.${r.toColumn}`;
}

/* -----------------------------
   État global
-------------------------------- */
let cy = null;
let layoutAlreadyRun = false;
let model = {
  tables: {},        // { [tableName]: { columns:[{name,type,pk,fk?}], pk:[...], fks:[...]} }
  relationships: [], // [{fromTable,fromColumn,toTable,toColumn,cardinality}]
  layout: 'dagre',
  positions: {}      // { nodeId: {x,y} }
};

/* -----------------------------
   Initialisation
-------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  // Boutons & entrées
  document.getElementById('csvInput').addEventListener('change', onImportCsv);
  document.getElementById('btnFit').addEventListener('click', fitGraph);
  document.getElementById('btnExport').addEventListener('click', exportJson);
  document.getElementById('btnShare').addEventListener('click', shareLink);
  document.getElementById('searchTable').addEventListener('input', filterTables);
  document.getElementById('btnExportSQL').addEventListener('click', exportSQL);

  // Lien exemple CSV
  const sample = [
    'table,column,type,pk,fk',
    'Customers,CustomerID,INT,yes,',
    'Customers,Name,VARCHAR(100),,',
    'Orders,OrderID,INT,yes,',
    'Orders,CustomerID,INT,,Customers.CustomerID',
    'OrderLines,OrderLineID,INT,yes,',
    'OrderLines,OrderID,INT,,Orders.OrderID',
    'OrderLines,ProductID,INT,,Products.ProductID',
    'Products,ProductID,INT,yes,',
    'Products,Name,VARCHAR(100),,'
  ].join('\n');

  const sampleBlob = new Blob([sample], { type: 'text/csv' });
  const url = URL.createObjectURL(sampleBlob);
  document.getElementById('downloadSample').href = url;

  // Charger depuis URL hash si présent
  tryLoadFromHash();

  // Si rien, init graphe vide
  if (!cy) initGraph([]);
});

/* -----------------------------
   Import CSV
-------------------------------- */
function onImportCsv(evt) {
  const file = evt.target.files?.[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (res) => {
      const rows = res.data;
      buildModelFromRows(rows);
      renderAll();
    },
    error: (err) => alert('Erreur de parsing CSV: ' + err.message)
  });
}

function mapHeaders(row) {
  // Map column names to canonical keys
  const mapping = {};
  for (const k of Object.keys(row)) {
    const nk = normalizeKey(k);
    if (['table','tablename','nomtable'].includes(nk)) mapping[k] = 'table';
    else if (['column','colonne','field','champ','columnname'].includes(nk)) mapping[k] = 'column';
    else if (['type','datatype','typeduchamp','typedata'].includes(nk)) mapping[k] = 'type';
    else if (['pk','primarykey','cleprimaire','cleprimaire','primary_key'].includes(nk)) mapping[k] = 'pk';
    else if (['fk','foreignkey','cleetrangere','cleetrangere','foreign_key'].includes(nk)) mapping[k] = 'fk';
    else mapping[k] = nk; // keep, but unused
  }
  return mapping;
}

function buildModelFromRows(rows) {
  model = { tables: {}, relationships: [], layout: 'dagre', positions: {} };
  layoutAlreadyRun = false;  // Réinitialiser le layout

  if (!rows || !rows.length) return;

  const headerMap = mapHeaders(rows[0]);

  const tables = {};
  const rels = [];

  for (const r of rows) {
    const tName = (r[Object.keys(r).find(k => headerMap[k] === 'table')] || '').toString().trim();
    const cName = (r[Object.keys(r).find(k => headerMap[k] === 'column')] || '').toString().trim();
    const dtype = (r[Object.keys(r).find(k => headerMap[k] === 'type')] || '').toString().trim();
    const pkv   = (r[Object.keys(r).find(k => headerMap[k] === 'pk')]);
    const fkv   = (r[Object.keys(r).find(k => headerMap[k] === 'fk')]);

    if (!tName || !cName) continue;

    if (!tables[tName]) {
      tables[tName] = { columns: [], pk: [], fks: [] };
    }

    const isPk = truthy(pkv);
    const fk = parseFk(fkv, cName);

    tables[tName].columns.push({
      name: cName,
      type: dtype || '',
      pk: !!isPk,
      fk: fk ? { ...fk } : null
    });

    if (isPk) tables[tName].pk.push(cName);

    if (fk) {
      tables[tName].fks.push({
        from: cName,
        toTable: fk.refTable,
        toColumn: fk.refColumn
      });
      rels.push({
        fromTable: tName,
        fromColumn: cName,
        toTable: fk.refTable,
        toColumn: fk.refColumn,
        cardinality: 'N:1'
      });
    }
  }

  // Dédupliquer les relations
  const seen = new Set();
  model.relationships = rels.filter(r => {
    const key = idRel(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  model.tables = tables;
}

/* -----------------------------
   Rendu UI global
-------------------------------- */
function renderAll() {
  layoutAlreadyRun = false;  // Réinitialiser le layout pour le nouveau modèle
  renderSidebar();
  buildGraph();
  fitGraph();
  clearInspector();
}

/* -----------------------------
   Sidebar (liste des tables)
-------------------------------- */
function renderSidebar() {
  const ul = document.getElementById('tableList');
  ul.innerHTML = '';

  const names = Object.keys(model.tables).sort((a,b) => a.localeCompare(b));

  for (const name of names) {
    const li = document.createElement('li');
    li.dataset.table = name;
    const colCount = model.tables[name].columns.length;
    const pkCount = model.tables[name].pk.length;
    li.innerHTML = `
      <span style="flex: 1; font-weight: 500; display: flex; align-items: center; gap: 6px;">
        📊 ${name}
      </span>
      <span class="badge">${colCount} col</span>
    `;
    li.addEventListener('click', () => focusTable(name));
    li.addEventListener('mouseenter', () => {
      li.style.transform = 'scale(1.02)';
    });
    li.addEventListener('mouseleave', () => {
      li.style.transform = 'scale(1)';
    });
    ul.appendChild(li);
  }
}

function filterTables(e) {
  const q = e.target.value.toLowerCase().trim();
  const items = document.querySelectorAll('#tableList li');
  items.forEach(li => {
    const name = li.dataset.table.toLowerCase();
    li.style.display = name.includes(q) ? '' : 'none';
  });
}

/* -----------------------------
   Graphe (Cytoscape)
-------------------------------- */
function initGraph(elements) {
  cytoscape.use(window.cytoscapeDagre);

  cy = cytoscape({
    container: document.getElementById('graph'),
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'shape': 'round-rectangle',
          'background-color': '#1e3a8a',
          'background-gradient-stop-colors': '#1e3a8a #3b82f6 #1e40af',
          'background-gradient-direction': '135deg',
          'border-width': 2.5,
          'border-color': '#60a5fa',
          'border-opacity': 0.6,
          'label': 'data(label)',
          'color': '#ffffff',
          'text-wrap': 'wrap',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': 14,
          'font-weight': 'bold',
          'padding': '14px',
          'width': 'label',
          'height': 'label',
          'min-width': 140,
          'min-height': 60,
          'text-max-width': 110,
          'text-overflow-wrap': 'ellipsis',
          'shadow-blur': 12,
          'shadow-color': 'rgba(59, 130, 246, 0.3)',
          'shadow-offset-x': 0,
          'shadow-offset-y': 4,
          'cursor': 'grab'
        }
      },
      {
        selector: 'node:grabbed',
        style: {
          'cursor': 'grabbing'
        }
      },
      {
        selector: 'node.highlighted',
        style: {
          'border-color': '#10b981',
          'border-width': 4,
          'background-color': '#065f46',
          'background-gradient-stop-colors': '#065f46 #10b981 #059669',
          'box-shadow': '0 0 24px rgba(16, 185, 129, 0.6)',
          'shadow-blur': 20,
          'shadow-color': 'rgba(16, 185, 129, 0.5)',
          'shadow-offset-y': 6
        }
      },
      {
        selector: 'node.faded',
        style: { 
          'opacity': 0.22,
          'border-opacity': 0.2
        }
      },
      {
        selector: 'edge',
        style: {
          'line-color': '#64748b',
          'target-arrow-color': '#64748b',
          'target-arrow-shape': 'triangle',
          'target-arrow-fill': 'filled',
          'target-arrow-width': 1.2,
          'target-arrow-height': 1.2,
          'curve-style': 'bezier',
          'width': 3,
          'line-cap': 'round',
          'line-join': 'round',
          'opacity': 0.7,
          'label': 'data(label)',
          'font-size': 12,
          'font-weight': 'bold',
          'text-rotation': 'autorotate',
          'text-margin-y': -12,
          'text-background-color': '#0a1428',
          'text-background-opacity': 0.95,
          'text-background-padding': '4px',
          'text-background-shape': 'round-rectangle',
          'color': '#cbd5e1',
          'shadow-blur': 8,
          'shadow-color': 'rgba(100, 116, 139, 0.2)',
          'shadow-offset-y': 2
        }
      },
      {
        selector: 'edge.highlighted',
        style: {
          'line-color': '#10b981',
          'target-arrow-color': '#10b981',
          'width': 4.5,
          'color': '#10b981',
          'opacity': 1,
          'z-index': 10,
          'shadow-blur': 12,
          'shadow-color': 'rgba(16, 185, 129, 0.4)',
          'shadow-offset-y': 3
        }
      },
      {
        selector: 'edge.faded',
        style: { 
          'opacity': 0.08,
          'width': 2
        }
      },
      { selector: ':selected', style: { 'overlay-opacity': 0 } }
    ],
    layout: { 
      name: 'dagre', 
      nodeSep: 100,
      edgeSep: 25,
      rankSep: 140,
      rankDir: 'TB',
      align: 'UL',
      acyclicer: 'greedy',
      animate: true,
      animationDuration: 500
    },
    wheelSensitivity: 0.1,
    minZoom: 0.05,
    maxZoom: 4,
    autolock: false,
    autoungrabify: false,
    boxSelectionEnabled: false
  });

  cy.on('tap', 'node', (evt) => {
    const name = evt.target.id();
    focusTable(name);
  });

  // Sauvegarder les positions lors du drag
  cy.on('dragfree', 'node', (evt) => {
    const n = evt.target;
    model.positions[n.id()] = { ...n.position() };
  });

  // Aide visuelle
  const help = document.createElement('div');
  help.className = 'cy-helper-note';
  help.innerHTML = '💡 Double-clic pour dé-sélectionner • Drag pour déplacer • Molette pour zoomer';
  document.getElementById('graph').appendChild(help);

  cy.on('dbltap', () => clearFocus());
}

function buildGraph() {
  const elements = [];

  // Nodes
  for (const name of Object.keys(model.tables)) {
    elements.push({ data: { id: name, label: name } });
  }

  // Edges
  for (const r of model.relationships) {
    const label = r.cardinality || 'N:1';
    elements.push({
      data: {
        id: idRel(r),
        source: r.fromTable,
        target: r.toTable,
        label,
        fromTable: r.fromTable,
        fromColumn: r.fromColumn,
        toTable: r.toTable,
        toColumn: r.toColumn
      }
    });
  }

  if (!cy) {
    initGraph(elements);
  } else {
    cy.elements().remove();
    cy.add(elements);
  }

  // Appliquer le layout SEULEMENT la première fois
  if (!layoutAlreadyRun) {
    const layout = cy.layout({ 
      name: 'dagre', 
      nodeSep: 100,
      edgeSep: 25,
      rankSep: 140,
      rankDir: 'TB',
      align: 'UL',
      acyclicer: 'greedy',
      animate: true,
      animationDuration: 500
    });
    layout.run();
    layoutAlreadyRun = true;
  }

  // Animation d'apparition des nœuds
  setTimeout(() => {
    const nodes = cy.nodes();
    nodes.forEach((n, i) => {
      const pos = model.positions[n.id()];
      if (pos) {
        n.position(pos);
      }
      // Légère animation cascade
      n.animate({
        style: { 'opacity': 1 }
      }, { duration: 200, delay: i * 50 });
    });
  }, 100);

  // Hover effects
  cy.on('mouseover', 'node', (evt) => {
    const n = evt.target;
    n.animate({
      style: { 'border-width': 3.5 }
    }, { duration: 150 });
  });

  cy.on('mouseout', 'node', (evt) => {
    const n = evt.target;
    if (!n.hasClass('highlighted')) {
      n.animate({
        style: { 'border-width': 2.5 }
      }, { duration: 150 });
    }
  });
}

function fitGraph() {
  if (!cy) return;
  cy.animate({
    fit: { eles: cy.elements(), padding: 60 }
  }, { duration: 600, easing: 'ease-in-out-back' });
}

function clearFocus() {
  if (!cy) return;
  // Désactiver tous les éléments (nœuds et edges)
  cy.nodes().animate({
    style: { 'opacity': 1 }
  }, { duration: 300 }).removeClass('faded').removeClass('highlighted');
  
  cy.edges().animate({
    style: { 'opacity': 0.7 }
  }, { duration: 300 }).removeClass('faded').removeClass('highlighted');
  
  document.querySelectorAll('#tableList li').forEach(li => li.classList.remove('active'));
  clearInspector();
}

function focusTable(name) {
  if (!cy) return;
  const node = cy.getElementById(name);
  if (!node || node.empty()) return;

  // Sidebar highlight
  document.querySelectorAll('#tableList li').forEach(li => {
    li.classList.toggle('active', li.dataset.table === name);
  });

  // 1) Fade tous les éléments (nœuds et edges)
  cy.elements().addClass('faded');
  
  // 2) Highlightla table sélectionnée
  node.removeClass('faded').addClass('highlighted');
  
  // 3) Récupérer les nœuds voisins et leurs edges
  const neighbors = node.closedNeighborhood();
  neighbors.removeClass('faded').addClass('highlighted');
  
  // 4) Enlever le fade et ajouter highlight aux edges connectés à la table sélectionnée
  const connectedEdges = node.connectedEdges();
  connectedEdges.forEach(edge => {
    edge.removeClass('faded').addClass('highlighted');
  });
  
  // Animation du zoom
  cy.animate({
    fit: { eles: neighbors.union(node), padding: 100 }
  }, { duration: 600, easing: 'ease-in-out-back' });

  // Inspector
  renderInspector(name);
}

/* -----------------------------
   Panneau de droite (Inspector)
-------------------------------- */
function clearInspector() {
  document.getElementById('tableMeta').textContent = '(sélectionnez une table)';
  document.getElementById('columns').innerHTML = '';
  document.getElementById('relations').innerHTML = '';
}

function renderInspector(tableName) {
  const t = model.tables[tableName];
  if (!t) return;

  // Meta
  const pkText = t.pk.length ? `PK: ${t.pk.join(', ')}` : 'PK: (aucune)';
  document.getElementById('tableMeta').textContent =
    `${tableName} — ${t.columns.length} colonne(s) • ${pkText}`;

  // Colonnes
  const colsDiv = document.getElementById('columns');
  colsDiv.innerHTML = '';
  for (const c of t.columns) {
    const div = document.createElement('div');
    div.className = 'col-item';
    const typeStr = c.type || '';
    const isPk = c.pk ? '🔑' : '';
    div.innerHTML = `
      <div class="col-header">
        <strong>${isPk} ${c.name}</strong>
        ${typeStr ? `<span>${typeStr}</span>` : ''}
      </div>
      <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
        ${c.pk ? '<span class="tag pk">PK</span>' : ''}
        ${c.fk ? `<span class="tag fk">FK → ${c.fk.refTable}</span>` : ''}
      </div>
    `;
    colsDiv.appendChild(div);
  }

  // Relations (entrantes/sortantes)
  const relDiv = document.getElementById('relations');
  relDiv.innerHTML = '';

  const rels = model.relationships.filter(r =>
    r.fromTable === tableName || r.toTable === tableName
  );

  if (!rels.length) {
    relDiv.innerHTML = '<div class="rel-item" style="color: var(--text-muted); text-align: center; padding: 20px; font-style: italic;">🔗 Aucune relation</div>';
    return;
  }

  for (const r of rels) {
    const relId = idRel(r);

    const div = document.createElement('div');
    div.className = 'rel-item';
    const dir = (r.fromTable === tableName) ? '→' : '←';
    const relText = (r.fromTable === tableName) 
      ? `${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`
      : `${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`;

    div.innerHTML = `
      <div class="row" style="margin-bottom: 8px;">
        <strong>🔗 ${relText}</strong>
      </div>
      <div class="row">
        <label for="card-${relId}">Cardinalité :</label>
        <select id="card-${relId}">
          <option value="N:1">N:1</option>
          <option value="1:1">1:1</option>
          <option value="N:N">N:N</option>
        </select>
      </div>
    `;
    relDiv.appendChild(div);

    const sel = div.querySelector('select');
    sel.value = r.cardinality || 'N:1';
    sel.addEventListener('change', () => {
      r.cardinality = sel.value;
      // MAJ label sur l'arête
      const edge = cy.getElementById(relId);
      if (edge && edge.nonempty()) {
        edge.animate({
          style: { 'label': r.cardinality }
        }, { duration: 300 });
        edge.data('label', r.cardinality);
      }
    });
  }
}

/* -----------------------------
   Export / Partage
-------------------------------- */
function exportJson() {
  const payload = {
    version: 1,
    model
  };
  const data = JSON.stringify(payload, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'data_model.json';
  a.click();
  URL.revokeObjectURL(url);
}

function shareLink() {
  const payload = { version: 1, model };
  const data = JSON.stringify(payload);
  const compressed = LZString.compressToEncodedURIComponent(data);
  const link = `${location.origin}${location.pathname}#data=${compressed}`;

  navigator.clipboard.writeText(link)
    .then(() => alert('Lien copié dans le presse-papiers !'))
    .catch(() => {
      prompt('Copiez le lien suivant :', link);
    });
}

function tryLoadFromHash() {
  const m = location.hash.match(/data=([^&]+)/);
  if (!m) return;
  try {
    const json = LZString.decompressFromEncodedURIComponent(m[1]);
    const payload = JSON.parse(json);
    if (payload?.model?.tables) {
      model = payload.model;
      buildGraph();
      renderSidebar();
      fitGraph();
    }
  } catch (e) {
    console.warn('Impossible de charger depuis l’URL:', e);
  }
}

/* -----------------------------
   Export SQL (DDL)
-------------------------------- */
function exportSQL() {
  const dialect = document.getElementById('sqlDialect')?.value || 'postgres';
  const sql = generateSQL(model, { dialect, includeFkIndexes: true });

  const blob = new Blob([sql], { type: 'text/sql;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `schema_${dialect}.sql`;
  a.click();
  URL.revokeObjectURL(url);
}

function generateSQL(model, opts = {}) {
  const { dialect = 'postgres', includeFkIndexes = true } = opts;

  const qi = (name) => quoteIdent(name, dialect);         // quote identifier
  const qn = (name) => name;                               // raw name for comments
  const now = new Date().toISOString();

  const lines = [];
  lines.push(`-- Schéma généré le ${now}`);
  lines.push(`-- Dialecte: ${dialect}`);
  lines.push(``);

  // 1) CREATE TABLE (sans FKs pour éviter l’ordre de dépendance)
  const tableNames = Object.keys(model.tables).sort((a, b) => a.localeCompare(b));

  for (const tName of tableNames) {
    const t = model.tables[tName];
    if (!t) continue;

    const colLines = [];
    const pkCols = (t.pk || []).filter(Boolean);

    for (const c of (t.columns || [])) {
      const cName = c.name;
      const rawType = (c.type || '').trim();
      const colType = rawType || defaultTypeForDialect(dialect);
      const notNull = c.pk ? ' NOT NULL' : ''; // On force NOT NULL sur PK

      colLines.push(`  ${qi(cName)} ${normalizeType(colType, dialect)}${notNull}`);
    }

    if (pkCols.length) {
      const pkQuoted = pkCols.map(qi).join(', ');
      colLines.push(`  PRIMARY KEY (${pkQuoted})`);
    }

    lines.push(`-- Table: ${qn(tName)}`);
    lines.push(`CREATE TABLE ${qi(tName)} (`);
    lines.push(colLines.join(`,\n`));
    lines.push(`);`);
    lines.push(``);
  }

  // 2) CONSTRAINTS FKs + UNIQUE pour 1:1 + INDEX sur FK
  for (const r of (model.relationships || [])) {
    // Vérifications de présence
    const src = model.tables[r.fromTable];
    const dst = model.tables[r.toTable];
    if (!src || !dst) {
      lines.push(`-- ATTENTION: relation ignorée (table manquante) ${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}`);
      continue;
    }
    const srcHasCol = (src.columns || []).some(c => c.name === r.fromColumn);
    const dstHasCol = (dst.columns || []).some(c => c.name === r.toColumn);
    if (!srcHasCol || !dstHasCol) {
      lines.push(`-- ATTENTION: relation ignorée (colonne manquante) ${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}`);
      continue;
    }

    const fkName = sanitizeConstraintName(`fk_${r.fromTable}_${r.fromColumn}_to_${r.toTable}_${r.toColumn}`);
    const uqName = sanitizeConstraintName(`uq_${r.fromTable}_${r.fromColumn}`);
    const idxName = sanitizeConstraintName(`idx_${r.fromTable}_${r.fromColumn}_fk`);

    const onUpdate = `ON UPDATE CASCADE`;
    const onDelete = `ON DELETE NO ACTION`;

    // FOREIGN KEY
    lines.push(`ALTER TABLE ${qi(r.fromTable)}`);
    lines.push(`  ADD CONSTRAINT ${qi(fkName)} FOREIGN KEY (${qi(r.fromColumn)})`);
    lines.push(`  REFERENCES ${qi(r.toTable)} (${qi(r.toColumn)}) ${onUpdate} ${onDelete};`);
    lines.push(``);

    // UNIQUE sur la FK si cardinalité 1:1 (et si pas déjà PK)
    const isOneToOne = (r.cardinality || '').toUpperCase() === '1:1';
    const isAlreadyPk = (src.pk || []).includes(r.fromColumn);
    if (isOneToOne && !isAlreadyPk) {
      lines.push(`-- Cardinalité 1:1 → contrainte UNIQUE sur ${r.fromTable}.${r.fromColumn}`);
      lines.push(`ALTER TABLE ${qi(r.fromTable)} ADD CONSTRAINT ${qi(uqName)} UNIQUE (${qi(r.fromColumn)});`);
      lines.push(``);
    }

    // Index sur la FK (utile dans la plupart des SGBD)
    if (includeFkIndexes) {
      lines.push(`-- Index d’aide sur la clé étrangère`);
      lines.push(`CREATE INDEX ${qi(idxName)} ON ${qi(r.fromTable)} (${qi(r.fromColumn)});`);
      lines.push(``);
    }
  }

  return lines.join('\n');
}

/* Helpers SQL */

function quoteIdent(name, dialect) {
  if (name == null) return '""';
  const s = String(name);
  switch (dialect) {
    case 'mysql':
      return '`' + s.replace(/`/g, '``') + '`';
    case 'mssql':
      return '[' + s.replace(/]/g, ']]') + ']';
    case 'sqlite':
    case 'postgres':
    default:
      return '"' + s.replace(/"/g, '""') + '"';
  }
}

function sanitizeConstraintName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 60);
}

function defaultTypeForDialect(dialect) {
  switch (dialect) {
    case 'mysql':  return 'VARCHAR(255)';
    case 'mssql':  return 'NVARCHAR(255)';
    case 'sqlite': return 'TEXT';
    case 'postgres':
    default:       return 'TEXT';
  }
}

// Laisse passer le type si fourni ; applique juste un fallback si vide.
function normalizeType(typeStr, dialect) {
  const t = (typeStr || '').trim();
  if (!t) return defaultTypeForDialect(dialect);
  return t; // on fait confiance à votre CSV pour les types
}


``