import itertools
import math
import pytest
from app.engine import Simulator, catalog

def set_vote(s,d,on,fid='FUN-04'):
    return s.command(dict(action='set_input',function_id=fid,division=d,value=90 if on else 50))

@pytest.mark.parametrize('bits',list(itertools.product((False,True),repeat=4)))
def test_T02_exhaustive_2oo4(bits):
    s=Simulator()
    for d,b in zip('ABCD',bits): set_vote(s,d,b)
    assert s.state()['trip_demand']==(sum(bits)>=2)

@pytest.mark.parametrize('bypass','ABCD')
@pytest.mark.parametrize('bits',list(itertools.product((False,True),repeat=4)))
def test_T03_exhaustive_2oo3(bypass,bits):
    s=Simulator(); s.command(dict(action='bypass',division=bypass,enabled=True))
    for d,b in zip('ABCD',bits): set_vote(s,d,b)
    assert s.state()['trip_demand']==(sum(b for d,b in zip('ABCD',bits) if d!=bypass)>=2)

def test_T04_no_cross_function_votes():
    s=Simulator(); set_vote(s,'A',True); set_vote(s,'B',True,'FUN-12')
    assert not s.state()['trip_demand']

@pytest.mark.parametrize('fid,value,expected',[('FUN-04',79.999,False),('FUN-04',80,True),('FUN-04',80.001,True),('FUN-09',20.001,False),('FUN-09',20,True),('FUN-09',19.999,True)])
def test_T01_demo_boundaries(fid,value,expected):
    s=Simulator(); state=s.command(dict(action='set_input',function_id=fid,division='all',value=value))
    assert state['trip_demand']==expected

def test_T11_single_bypass_and_demo_permissive():
    s=Simulator(); s.command(dict(action='bypass',division='A',enabled=True))
    with pytest.raises(ValueError): s.command(dict(action='bypass',division='B',enabled=True))
    assert s.state()['bypass']=='A'
    s.command(dict(action='start'))
    with pytest.raises(ValueError): s.command(dict(action='bypass',division='A',enabled=True))

def test_T16_latch_reset_reclose_separate():
    s=Simulator(); s.command(dict(action='manual_trip'))
    with pytest.raises(ValueError): s.command(dict(action='reset_trip'))
    s.command(dict(action='clear_manual'))
    assert s.state()['trip_latched']
    s.command(dict(action='reset_trip'))
    assert not s.state()['rod_drive_power']
    s.command(dict(action='reclose'))
    assert s.state()['rod_drive_power']

def test_T16_restart_preserves_trip_and_pauses(tmp_path):
    p=str(tmp_path/'rps.db'); s=Simulator(p)
    s.command(dict(action='manual_trip')); s.command(dict(action='start'))
    restarted=Simulator(p)
    assert restarted.state()['trip_latched'] and not restarted.state()['rod_drive_power']
    assert not restarted.state()['running']
    assert restarted.events()[0]['action']=='restart'

def test_T14_breaker_single_failure_and_output_polarities():
    s=Simulator(); s.command(dict(action='fault',division='A',fault='breaker_stuck'))
    st=s.command(dict(action='manual_trip'))
    assert st['divisions'][0]['breakers_open']==[False,True]
    assert all(not d['uv_energized'] and d['shunt_energized'] for d in st['divisions'])
    assert not st['rod_drive_power']

def test_T18_bypass_plus_fault_retains_vote():
    s=Simulator(); s.command(dict(action='bypass',division='A',enabled=True))
    s.command(dict(action='fault',division='B',fault='comms_loss'))
    assert not s.state()['trip_demand']
    assert set_vote(s,'C',True)['trip_demand']

def test_T18_bad_sensor_is_alarm_not_blanket_trip():
    s=Simulator()
    for d in 'ABCD': s.command(dict(action='fault',division=d,fault='sensor_bad'))
    assert not s.state()['trip_demand'] and len(s.state()['alarms'])==4

@pytest.mark.parametrize('value',[math.nan,math.inf,-math.inf,-1,101,True,'90',None])
def test_invalid_inputs_are_atomic(value):
    s=Simulator(); before=s.state()
    with pytest.raises(ValueError): s.command(dict(action='set_input',function_id='FUN-04',division='A',value=value))
    assert s.state()==before

def test_thermal_tbd_not_fabricated():
    s=Simulator()
    assert len(catalog())==19
    for fid in ('FUN-06','FUN-07'):
        with pytest.raises(ValueError): set_vote(s,'A',True,fid)
        f=next(f for f in s.state()['functions'] if f['id']==fid)
        assert f['status']=='TBD' and f['threshold'] is None and not f['coincidence']

def test_scenario_determinism_and_history_bound():
    s=Simulator(); s.command(dict(action='scenario',scenario='overpower'))
    for _ in range(6): s.command(dict(action='step'))
    assert s.state()['tick']==6 and s.state()['trip_demand']
    for _ in range(120): s.command(dict(action='step'))
    assert len(s.state()['history'])==120

def test_restore_inputs_does_not_clear_latch():
    s=Simulator(); s.command(dict(action='set_input',function_id='FUN-04',division='all',value=90))
    st=s.command(dict(action='restore_inputs'))
    assert not st['trip_demand'] and st['trip_latched']
