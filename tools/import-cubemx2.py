"""Import the official STM32C5 DFP used by CubeMX2. No inferred voltage limits."""
import argparse, json, re, xml.etree.ElementTree as ET
from pathlib import Path
from collections import defaultdict
parser=argparse.ArgumentParser()
parser.add_argument('--pack',default='tools/vendor/stm32c5xx-dfp')
a=parser.parse_args()
root=Path(a.pack)
r=ET.parse(root/'STMicroelectronics.stm32c5xx_dfp.pdsc').getroot()
release=r.find('./releases/release').get('version')
out=Path('tools/data/cubemx2'); (out/'mcus').mkdir(parents=True,exist_ok=True)
sets=['']; profiles=[]; entries=[]
def intern(items,value):
    if value not in items: items.append(value)
    return items.index(value)
def descriptors(element):
    return {x.get('schemaType'):x.get('path') for x in element.findall('.//descriptor')}
exclude={'cortex','gpio','rcc','pwr','sbs','dbg','exti','nvic','ramcfg','debug','flash','icache','fdcanram','ethphy'}
for family in r.findall('./devices/family'):
 for sub in family.findall('./subFamily'):
  per=json.loads((root/descriptors(sub)['peripherals']).read_text())['peripherals']
  limits=json.loads((root/descriptors(sub)['limitations']).read_text())['limitations']
  ram=sum(int(m.get('size'),0) for m in sub.findall('./memory') if 'SRAM' in m.get('name','').upper())/1024
  for dev in sub.findall('./device'):
   flash=sum(int(m.get('size'),0) for m in dev.findall('./memory') if m.get('name')=='FLASH')/1024
   for variant in dev.findall('./variant'):
    part=variant.get('Dvariant'); removed=set(limits.get(part,{}).get('removed_peripherals',[])); desc={**descriptors(dev),**descriptors(variant)}; pinfile=desc['pinout']
    data=json.loads((root/pinfile).read_text()); package=data['characteristics']['package_name']
    ident='st-'+part.lower()+'-'+package.lower()
    signals=defaultdict(list)
    for signal in data['signals']: signals[signal['die_pad']].append(signal)
    pins=[]; instance_signals=defaultdict(set)
    for bond in data['bonds']:
     pad=bond['die_pad']; info=data['die_pads'][pad]; gpio=info['type']=='gpio'
     name=re.match(r'P[A-Z][0-9]+',pad).group() if gpio else pad
     functions=[]; additional=[]; protection=[]
     for signal in signals[pad]:
      f=signal['function']; sig=signal['name']; instance=signal['instance']
      if instance in removed: continue
      if f['type']=='user_gpio': continue
      if sig.startswith('DEBUG_'): sig=sig.replace('DEBUG_','',1); protection.append('debug')
      if sig.startswith('RCC_'): sig=sig.replace('RCC_','',1); protection.append('oscillator')
      if f['type']=='alternate': functions.append({'name':sig,'af':int(f['id'].replace('AF',''))})
      else: additional.append(sig)
      if '_' in signal['name']: instance_signals[instance].add(signal['name'].split('_',1)[1])
     if not gpio and info.get('function')=='reset': protection.append('system')
     io=info.get('io_structure',{}); structure=io.get('type','-')+''.join(io.get('options',[]))
     pins.append({'number':int(bond['position']),'name':name,'resetName':pad,'kind':'gpio' if gpio else 'supply' if info.get('function')=='power_supply' else 'special','ioType':info.get('pin_type','-'),'ioStructure':structure,'notes':'-','functions':functions,'additionalFunctions':sorted(set(additional)),'protection':sorted(set(protection))})
    pins.sort(key=lambda p:p['number'])
    geometry={'shape':re.sub(r'[0-9]+$','',package)}
    if package.startswith(('LQFP','UFQFPN','QFN')): geometry.update(pinsPerSide=len(data['package_pins'])/4,numbering='counterclockwise')
    spec={'flashKB':flash,'ramKB':ram,'frequencyMHz':int(family.find('./processor').get('Dclock'))/1000000,'sourceRef':part+' / DFP '+release}
    record={'id':ident,'partNumber':part,'vendor':'STMicroelectronics','family':part[:9],'core':'ARM Cortex-M33','package':package,'pinCount':len(data['package_pins']),'uiProfile':'generic','status':'generated','analogConvention':'st','signalDialect':'st','packageGeometry':geometry,'source':{'document':'STM32CubeMX2 STM32C5 DFP','revision':release,'url':'https://github.com/STMicroelectronics/stm32c5xx-dfp','pinTable':pinfile,'afTable':pinfile},'pins':pins,'electrical':{'fiveVoltTolerantIoStructures':sorted({p['ioStructure'] for p in pins if p['ioStructure'].startswith('FT')})}}
    (out/'mcus'/(ident+'.json')).write_text(json.dumps(record,ensure_ascii=False),encoding='utf-8')
    tokens=[]
    for peripheral in per:
     name=peripheral['name']; typ=peripheral.get('peripheralType','')
     if typ.lower() in exclude or name in removed or peripheral.get('children') or peripheral.get('entityType') not in ['peripheral','peripheralBlock']: continue
     suffixes=instance_signals.get(name,set())
     # Interfaces with external signals are recorded only if bonded in this package.
     if peripheral.get('pinout_signals') and not suffixes: continue
     tokens.append(name+':'+str(intern(sets,' '.join(sorted(suffixes)))))
    pf=intern(profiles,' '.join(sorted(tokens)))
    entries.append({'id':ident,'vendor':'st','part':part,'series':part[:9],'family':'STM32C5','package':package,'pinCount':len(data['package_pins']),'core':'ARM Cortex-M33','specs':spec,'pf':pf,'sourceTool':'STM32CubeMX2','sourceRelease':release})
fragment={'source':{'vendor':'st','tool':'STM32CubeMX2','release':release,'root':str(root.resolve()),'count':len(entries)},'devices':entries,'profiles':profiles,'signalSets':sets}
(out/'index.json').write_text(json.dumps(fragment,ensure_ascii=False),encoding='utf-8')
print(f'Imported {len(entries)} C5 part/package combinations, DFP {release}')
