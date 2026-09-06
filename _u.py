import sqlite3
c = sqlite3.connect('data/erp.db')
c.row_factory = sqlite3.Row
for r in c.execute("SELECT id,username,name,role FROM users"):
    print(dict(r))