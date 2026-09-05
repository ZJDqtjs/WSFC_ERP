# -*- coding: utf-8 -*-
import re

def parse_jushuitan_name(name):
    out=[]; s=str(name or '').strip()
    if not s: return out
    s=s.replace('，',',').replace('；',';').replace('、',',').replace('\n',';').replace('\r',';')
    s=re.sub(r'^\d+\.?\d*\s*\.\s*','',s)
    for part in re.split(r'[;,]', s):
        part=part.strip()
        if not part: continue
        part=re.sub(r'^\d+\.?\d*\s*\.\s*','',part)
        pm=re.match(r'^(.*?)\*(\d+(?:\.\d+)?)\s*$', part)  # note: '$' at end
        if pm:
            product=pm.group(1).strip(); qty=float(pm.group(2))
        else:
            product=part; qty=1.0
        product=product.strip(' ()[]{}')
        if not product: continue
        out.append((product,qty))
    return out

tests=[
    '2.京鲜生四神汤200g*2',
    '10.京鲜生鸡骨草250g*10',
    '4.虫草花干货500g*1,香菇干货500g*3',
    '3.黑木耳干货500g*3',
    '2.香菇干货500g*2',
]
for t in tests:
    print(repr(t),'->',parse_jushuitan_name(t))