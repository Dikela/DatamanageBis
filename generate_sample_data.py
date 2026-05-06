#!/usr/bin/env python3
import csv
import random
from datetime import datetime, timedelta

random.seed(42)

def write_csv(path, header, rows):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow(r)

n_orders = 20
n_baskets = 20
n_items = 60
n_invoices = 20
n_allocations = 40

start_date = datetime(2024,1,1)

# Orders
orders = []
for i in range(1, n_orders+1):
    created = (start_date + timedelta(days=i)).isoformat(sep=' ')
    ord_label = f"Order {i:03d}"
    # optionally link to a basket (some nulls)
    if random.random() < 0.4:
        basket_id = random.randint(1, n_baskets)
    else:
        basket_id = ''
    orders.append([i, created, ord_label, basket_id])

write_csv('t_ord_order.csv', ['ord_id','created','ord_label_en','basket_id'], orders)

# Baskets
baskets = []
for i in range(1, n_baskets+1):
    created = (start_date + timedelta(days=i+2)).isoformat(sep=' ')
    label = f"Basket {i:03d}"
    # ord_id_previous sometimes points to an existing order
    if random.random() < 0.3:
        ord_prev = random.randint(1, n_orders)
    else:
        ord_prev = ''
    baskets.append([i, label, ord_prev, created])

write_csv('t_ord_basket.csv', ['basket_id','basket_label_en','ord_id_previous','created'], baskets)

# Invoices
invoices = []
for i in range(1, n_invoices+1):
    date = (start_date + timedelta(days=5+i)).date().isoformat()
    total = round(random.uniform(50, 5000), 2)
    invoices.append([i, date, total])

write_csv('t_ord_invoice.csv', ['invoice_id','invoice_date','invoice_total'], invoices)

# Items
items = []
for i in range(1, n_items+1):
    ord_id = random.randint(1, n_orders)
    basket_id = random.randint(1, n_baskets)
    label = f"Item {i:04d}"
    price = round(random.uniform(5, 800), 2)
    items.append([i, ord_id, basket_id, label, price])

write_csv('t_ord_item.csv', ['oitem_id','ord_id','basket_id','oitem_label','oitem_price'], items)

# Allocations
allocs = []
for i in range(1, n_allocations+1):
    oitem = random.randint(1, n_items)
    invoice = random.randint(1, n_invoices)
    qty = random.randint(1, 10)
    # find price from items (index offset)
    price = next((row[4] for row in items if row[0]==oitem), round(random.uniform(5,200),2))
    all_price = round(price * qty, 2)
    allocs.append([i, oitem, invoice, qty, all_price])

write_csv('t_ord_allocation.csv', ['all_id','oitem_id','invoice_id','all_quantity','all_price'], allocs)

# Also create a SQL inserts file
with open('sample_data.sql', 'w', encoding='utf-8') as f:
    f.write('-- Sample data generated\n')
    f.write("BEGIN;\n\n")
    for r in orders:
        ord_id, created, label, basket_id = r
        basket_sql = 'NULL' if basket_id=='' else str(basket_id)
        f.write(f"INSERT INTO \"t_ord_order\" (ord_id, created, ord_label_en, basket_id) VALUES ({ord_id}, '{created}', '{label}', {basket_sql});\n")
    f.write('\n')
    for r in baskets:
        basket_id, label, ord_prev, created = r
        ord_prev_sql = 'NULL' if ord_prev=='' else str(ord_prev)
        f.write(f"INSERT INTO \"t_ord_basket\" (basket_id, basket_label_en, ord_id_previous, created) VALUES ({basket_id}, '{label}', {ord_prev_sql}, '{created}');\n")
    f.write('\n')
    for r in invoices:
        invoice_id, date, total = r
        f.write(f"INSERT INTO \"t_ord_invoice\" (invoice_id, invoice_date, invoice_total) VALUES ({invoice_id}, '{date}', {total});\n")
    f.write('\n')
    for r in items:
        oitem_id, ord_id, basket_id, label, price = r
        f.write(f"INSERT INTO \"t_ord_item\" (oitem_id, ord_id, basket_id, oitem_label, oitem_price) VALUES ({oitem_id}, {ord_id}, {basket_id}, '{label}', {price});\n")
    f.write('\n')
    for r in allocs:
        all_id, oitem_id, invoice_id, qty, all_price = r
        f.write(f"INSERT INTO \"t_ord_allocation\" (all_id, oitem_id, invoice_id, all_quantity, all_price) VALUES ({all_id}, {oitem_id}, {invoice_id}, {qty}, {all_price});\n")
    f.write('\nCOMMIT;\n')

print('Generated CSV and sample_data.sql')
