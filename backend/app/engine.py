"""Educational reference model. All numerical limits and fault responses are DEMO policy."""
import copy
import json
import math
import sqlite3
import threading
from datetime import datetime, timezone

DIVISIONS = 'ABCD'
NAMES = ['Source-range high neutron flux','Intermediate-range high neutron flux','Power-range high neutron flux, low setpoint','Power-range high neutron flux, high setpoint','Power-range high positive flux rate','OTΔT','OPΔT','Low pressurizer pressure','Low reactor coolant flow','RCP underspeed','High RCP bearing water temperature','High pressurizer pressure','High pressurizer water level','Low water level in any SG','High-2 water level in any SG','ADS actuation trip','CMT actuation trip','Safeguards actuation trip','Manual reactor trip']

def catalog():
    return [dict(id=f'FUN-{i:02d}',name=name,status='TBD' if i in (6,7) else 'MANUAL' if i==19 else 'DEMO',direction='low' if i in (8,9,10,14) else 'high',threshold=None if i in (6,7,19) else 20 if i in (8,9,10,14) else 80,unit='DEMO normalized',limitations='Detailed plant algorithms, permissives, equipment mapping and setpoints not qualified.') for i,name in enumerate(NAMES,1)]

def initial():
    return dict(revision=0,tick=0,running=False,scenario='normal',trip_latched=False,manual_trip=False,bypass=None,inputs={f['id']:{d:50.0 for d in DIVISIONS} for f in catalog()},faults={d:'none' for d in DIVISIONS},breakers={d:[False,False] for d in DIVISIONS},history=[])

class Simulator:
    def __init__(self,path=':memory:'):
        self.lock=threading.RLock()
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, revision INTEGER NOT NULL)')
        row=self.db.execute('SELECT body FROM snapshot WHERE id=1').fetchone()
        self.s=json.loads(row[0]) if row else initial()
        self.s['running']=False
        self._evaluate()
        self._save('restart' if row else 'initialize', 'Paused on startup; latch and breaker state preserved')

    def _evaluate(self):
        functions=[]
        for f in catalog():
            values=self.s['inputs'][f['id']]
            votes={d:False for d in DIVISIONS}
            if f['status']=='DEMO':
                for d in DIVISIONS:
                    votes[d]= (values[d]<=f['threshold'] if f['direction']=='low' else values[d]>=f['threshold'])
                    # Explicit demo fault policy, not a claim about AP1000 sensor quality treatment.
                    if self.s['faults'][d] in ('comms_loss','power_loss'): votes[d]=True
            count=sum(v for d,v in votes.items() if d!=self.s['bypass'])
            functions.append(dict(f,value=sum(values.values())/4,values=copy.deepcopy(values),votes=votes,vote_count=count,coincidence=count>=2))
        demand=self.s['manual_trip'] or any(f['coincidence'] for f in functions)
        self.s['trip_latched'] |= demand
        divisions=[]
        for d in DIVISIONS:
            output=self.s['trip_latched'] or self.s['faults'][d]=='power_loss'
            if output:
                self.s['breakers'][d][1]=True
                if self.s['faults'][d]!='breaker_stuck': self.s['breakers'][d][0]=True
            divisions.append(dict(id=d,fault=self.s['faults'][d],bypassed=d==self.s['bypass'],partial_trip=any(f['votes'][d] for f in functions),uv_energized=not output,shunt_energized=output,breakers_open=list(self.s['breakers'][d])))
        power=sum(any(self.s['breakers'][d]) for d in DIVISIONS)<2
        alarms=[f"Division {d}: {self.s['faults'][d]} (DEMO fault policy)" for d in DIVISIONS if self.s['faults'][d]!='none']
        if self.s['bypass']: alarms.append('Division '+self.s['bypass']+' bypassed: 2oo3')
        if self.s['trip_latched']: alarms.append('Trip latch active; clear initiating conditions before reset')
        self.view=dict(revision=self.s['revision'],tick=self.s['tick'],running=self.s['running'],scenario=self.s['scenario'],mode='TRIPPED' if not power else 'DEGRADED' if alarms else 'NORMAL',trip_latched=self.s['trip_latched'],trip_demand=demand,manual_trip=self.s['manual_trip'],rod_drive_power=power,voting='2oo3' if self.s['bypass'] else '2oo4',bypass=self.s['bypass'],divisions=divisions,functions=functions,history=copy.deepcopy(self.s['history']),alarms=alarms)

    def _save(self,action,detail):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO snapshot VALUES (1,?)',(json.dumps(self.s),))
            self.db.execute('INSERT INTO events(timestamp,action,detail,revision) VALUES (?,?,?,?)',(datetime.now(timezone.utc).isoformat(),action,detail,self.s['revision']))

    def state(self):
        with self.lock: return copy.deepcopy(self.view)

    def events(self):
        with self.lock:
            return [dict(zip(('id','timestamp','action','detail','revision'),r)) for r in self.db.execute('SELECT * FROM events ORDER BY id DESC LIMIT 200')]

    def command(self,c):
        with self.lock:
            before=copy.deepcopy(self.s)
            try:
                self._command(c)
                self.s['revision']+=1
                self._evaluate()
                self._save(c['action'],json.dumps(c,ensure_ascii=False))
            except Exception:
                self.s=before
                self._evaluate()
                raise
            return self.state()

    def _command(self,c):
        a=c.get('action')
        if a in ('start','pause'): self.s['running']=a=='start'
        elif a=='step':
            self.s['tick']+=1
            scenario=self.s['scenario']
            fid={'overpower':'FUN-04','low_flow':'FUN-09','high_pressure':'FUN-12','sg_low':'FUN-14'}.get(scenario)
            if fid:
                delta=-5 if scenario in ('low_flow','sg_low') else 5
                for d in DIVISIONS: self.s['inputs'][fid][d]=max(0,min(100,self.s['inputs'][fid][d]+delta))
            self.s['history'].append(dict(tick=self.s['tick'],power=sum(self.s['inputs']['FUN-04'].values())/4,pressure=sum(self.s['inputs']['FUN-12'].values())/4,flow=sum(self.s['inputs']['FUN-09'].values())/4))
            self.s['history']=self.s['history'][-120:]
        elif a=='scenario':
            name=c.get('scenario')
            if name not in ('normal','overpower','low_flow','high_pressure','sg_low','sensor_fault'): raise ValueError('Unknown scenario')
            self.s['scenario']=name
            if name=='sensor_fault': self.s['faults']['A']='sensor_bad'
        elif a=='set_input':
            fid=c.get('function_id'); d=c.get('division'); value=c.get('value')
            if fid not in self.s['inputs'] or fid in ('FUN-06','FUN-07','FUN-19'): raise ValueError('Function is unavailable or TBD')
            if d not in (*DIVISIONS,'all'): raise ValueError('Unknown division')
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=100: raise ValueError('Input must be finite DEMO value 0..100')
            for division in DIVISIONS if d=='all' else d: self.s['inputs'][fid][division]=float(value)
        elif a=='bypass':
            d=c.get('division'); enabled=c.get('enabled')
            if d not in tuple(DIVISIONS) or type(enabled) is not bool: raise ValueError('Invalid bypass request')
            if enabled and self.s['bypass'] not in (None,d): raise ValueError('Only one division may be bypassed')
            if enabled and (self.s['running'] or self.view['trip_demand']): raise ValueError('DEMO maintenance permissive: pause with no active demand')
            if enabled: self.s['bypass']=d
            elif self.s['bypass']==d: self.s['bypass']=None
        elif a=='fault':
            d=c.get('division'); fault=c.get('fault')
            if d not in tuple(DIVISIONS) or fault not in ('none','sensor_bad','comms_loss','power_loss','breaker_stuck'): raise ValueError('Invalid fault request')
            self.s['faults'][d]=fault
        elif a=='manual_trip': self.s['manual_trip']=True
        elif a=='clear_manual': self.s['manual_trip']=False
        elif a=='reset_trip':
            if self.view['trip_demand']: raise ValueError('Reset rejected while initiating demand remains')
            self.s['trip_latched']=False
        elif a=='reclose':
            if self.s['trip_latched'] or self.view['trip_demand'] or any(f!='none' for f in self.s['faults'].values()) or self.s['bypass']: raise ValueError('Reclose requires cleared latch, faults and bypass')
            self.s['breakers']={d:[False,False] for d in DIVISIONS}
        elif a=='restore_inputs':
            self.s['inputs']=initial()['inputs']; self.s['scenario']='normal'
        else: raise ValueError('Unknown command')
