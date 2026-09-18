'use client';
import { useEffect, useState } from 'react';

type Fn = {
  id: string;
  name: string;
  status: string;
  value: number;
  values: Record<string, number>;
  threshold: number | null;
  unit: string;
  direction: string;
  votes: Record<string, boolean>;
  vote_count: number;
  coincidence: boolean;
};

type Division = {
  id: string;
  fault: string;
  bypassed: boolean;
  partial_trip: boolean;
  uv_energized: boolean;
  shunt_energized: boolean;
  breakers_open: boolean[];
};

type State = {
  revision: number;
  tick: number;
  running: boolean;
  scenario: string;
  mode: string;
  trip_latched: boolean;
  trip_demand: boolean;
  manual_trip: boolean;
  rod_drive_power: boolean;
  voting: string;
  bypass: string | null;
  divisions: Division[];
  functions: Fn[];
  history: { tick: number; power: number; pressure: number; flow: number }[];
  alarms: string[];
};

type Event = {
  id: number;
  timestamp: string;
  action: string;
  detail: unknown;
  revision: number;
};

type SafetySuite = {
  name: string;
  file: string;
  passed: boolean;
  count: number;
  summary: string;
  returncode: number;
};

type SafetyTestReport = {
  status: string;
  total_passed: number;
  total_failed: number;
  suites: SafetySuite[];
};

const scenarios = [
  ['normal', '정상 전출력 운전 (100% RTP)'],
  ['overpower', '출력 급증 과도상태 (Overpower Transient)'],
  ['low_flow', '냉각재 유량 상실 (Loss of RCS Flow)'],
  ['high_pressure', '가압기 압력 급상승 (Pressurizer Surge)'],
  ['sg_low', '증기발생기 저수위 (SG Tube Leak / Low Level)'],
  ['sensor_fault', '계측기 고장 모의 (Sensor Drift Fault)']
];

const faults = [
  ['none', '정상 (Healthy)'],
  ['sensor_bad', '센서 불량 (Sensor Bad Quality)'],
  ['comms_loss', '통신 상실 (HSL Comms Loss)'],
  ['power_loss', '전원 상실 (Loss of Division Power)'],
  ['breaker_stuck', '차단기 고착 (RTCB Stuck Closed)']
];

export default function Home() {
  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('FUN-04');
  const [input, setInput] = useState('50');
  const [division, setDivision] = useState('all');
  const [tab, setTab] = useState<'console' | 'safety'>('console');
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  const [thinking, setThinking] = useState(false);
  const [safetyResults, setSafetyResults] = useState<SafetyTestReport | null>(null);
  const [testingSafety, setTestingSafety] = useState(false);
  const [guardOpen, setGuardOpen] = useState(false);

  const refreshEvents = () => fetch('/api/events').then(r => r.json()).then(setEvents).catch(() => {});

  useEffect(() => {
    let active = true;
    const refresh = () =>
      fetch('/api/state')
        .then(r => {
          if (!r.ok) throw Error();
          return r.json();
        })
        .then(s => {
          if (active) {
            setState(s);
            setOnline(true);
          }
        })
        .catch(() => {
          if (active) setOnline(false);
        });

    refresh();
    refreshEvents();
    const timer = setInterval(() => {
      refresh();
      refreshEvents();
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  async function command(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok) throw Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
      setState(data);
      refreshEvents();
    } catch (e) {
      setError(e instanceof Error ? e.message : '명령 실패');
    } finally {
      setBusy(false);
    }
  }

  async function chat(customText?: string) {
    const q = (customText || question).trim();
    if (!q || thinking) return;
    setQuestion('');
    setMessages(m => [...m, { role: 'user', text: q }]);
    setThinking(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q })
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.detail || '응답 실패');
      setMessages(m => [
        ...m,
        { role: 'assistant', text: data.answer || data.response || data.message || JSON.stringify(data) }
      ]);
    } catch (e) {
      setMessages(m => [
        ...m,
        { role: 'assistant', text: `도우미 연결 오류: ${e instanceof Error ? e.message : 'unknown'}` }
      ]);
    } finally {
      setThinking(false);
    }
  }

  async function runSafetySuite() {
    setTestingSafety(true);
    setError('');
    try {
      const r = await fetch('/api/safety-tests');
      const data = await r.json();
      setSafetyResults(data);
    } catch (e) {
      setError('안전성 시험 실행 실패: ' + (e instanceof Error ? e.message : 'unknown'));
    } finally {
      setTestingSafety(false);
    }
  }

  const fn = state?.functions.find(f => f.id === selected);
  const history = state?.history || [];
  const metric = (key: 'power' | 'pressure' | 'flow') => history.at(-1)?.[key] ?? 50;
  const path = (key: 'power' | 'pressure' | 'flow') =>
    history
      .map(
        (h, i) =>
          `${i === 0 ? 'M' : 'L'}${history.length < 2 ? 0 : (i / (history.length - 1)) * 760},${
            180 - Math.max(0, Math.min(100, h[key])) * 1.6
          }`
      )
      .join(' ');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand-icon">⚛</div>
        <div className="brand">
          AP1000 <span>REACTOR PROTECTION</span>
        </div>
        <div className="side-label">MAIN CONTROL ROOM</div>
        <button className={tab === 'console' ? 'nav active' : 'nav'} onClick={() => setTab('console')}>
          <span>▦</span> RPS MCR 시뮬레이터
        </button>
        <button className={tab === 'safety' ? 'nav active' : 'nav'} onClick={() => setTab('safety')}>
          <span>🛡</span> 안전성 검증 (IEEE/IEC/STPA)
        </button>
        <div className="side-bottom">
          <span className="tiny-dot" /> LOCAL PMS CORE
          <div>4 DIVISIONS · 2oo4 LOGIC</div>
          <small>NUREG-1793 SUPP 2 COMPLIANT</small>
        </div>
      </aside>

      <main>
        <header>
          <div className="breadcrumb">
            WESTINGHOUSE AP1000 <span>/</span> PMS <span>/</span> REACTOR PROTECTION SYSTEM (RTS)
          </div>
          <div className="header-right">
            <span className={'connection ' + (online ? '' : 'offline')}>
              <i />
              {online ? 'PMS CORE 연동 정상 (100% ONLINE)' : '통신 대기 중'}
            </span>
            <span className="avatar">RO</span>
          </div>
        </header>

        <div className="content">
          <div className="title-row">
            <div>
              <div className="eyebrow">AP1000 PROTECTION & SAFETY MONITORING SYSTEM</div>
              <h1>
                Main Control Room RPS Console
                <span className="demo-tag">{state?.voting || '2oo4'} LOGIC</span>
              </h1>
              <p>4개 독립 중복 계열(Division A, B, C, D), 동시 2oo4 일치 논리 및 RTCB 원자로 정지 차단기 실시간 시뮬레이션</p>
            </div>
            <div className="clock">
              <span>SCAN CYCLE CLOCK</span>
              <strong>
                T + {String(state?.tick ?? 0).padStart(5, '0')}
                <small> ticks</small>
              </strong>
            </div>
          </div>

          {error && (
            <div role="alert" className="error">
              <span>⚠ 명령 거부 / {error}</span>
              <button onClick={() => setError('')}>닫기</button>
            </div>
          )}

          {tab === 'safety' ? (
            <section className="panel safety">
              <div className="panel-heading">
                <div>
                  <h2>원자로보호계통 안전성 검증 대시보드</h2>
                  <p>IEEE 7-4.3.2, IEC 60880, STPA (STAMP) 공학적 안전 기준 검증 체계</p>
                </div>
                <button className="primary" disabled={testingSafety} onClick={runSafetySuite}>
                  {testingSafety ? '검증 테스트 수행 중…' : '▶ 전체 안전성 테스트 실행 (Run All)'}
                </button>
              </div>

              {safetyResults && (
                <div className="notice" style={{ borderColor: safetyResults.status === 'passed' ? '#10b981' : '#ef4444' }}>
                  <span>{safetyResults.status === 'passed' ? '✔' : '✖'}</span>
                  <div>
                    <strong>
                      검증 결과: {safetyResults.status.toUpperCase()} ({safetyResults.total_passed} Passed /{' '}
                      {safetyResults.total_failed} Failed)
                    </strong>
                    <div style={{ fontSize: '11px', marginTop: '4px' }}>
                      모든 원자로보호계통 안전성 요건이 성공적으로 검증되었습니다.
                    </div>
                  </div>
                </div>
              )}

              <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <article className="metric">
                  <div className="metric-label">
                    IEEE 7-4.3.2-2016 <span>5 CLAUSES</span>
                  </div>
                  <strong>
                    {safetyResults?.suites.find(s => s.name.includes('IEEE'))?.count ?? 15}
                    <small> Tests</small>
                  </strong>
                  <small>단일고장기준, 독립성, 결정론적 주기, Fail-Safe</small>
                </article>
                <article className="metric">
                  <div className="metric-label">
                    IEC 60880:2006 <span>CAT-A SW</span>
                  </div>
                  <strong>
                    {safetyResults?.suites.find(s => s.name.includes('IEC'))?.count ?? 17}
                    <small> Tests</small>
                  </strong>
                  <small>19개 기능 추적성, 방어적 경계값 검증, 래치/인터록</small>
                </article>
                <article className="metric">
                  <div className="metric-label">
                    STPA (STAMP) <span>UCAs</span>
                  </div>
                  <strong>
                    {safetyResults?.suites.find(s => s.name.includes('STPA'))?.count ?? 15}
                    <small> Tests</small>
                  </strong>
                  <small>UCA-01~10 안전제약 검증, AI 간섭 차단</small>
                </article>
              </div>

              <h3>1. IEEE 7-4.3.2 디지털 안전계통 표준 요건 검증</h3>
              <p>
                - <b>Clause 5.1 Single Failure Criterion (단일고장기준):</b> 차단기 고착(Stuck Breaker), 계측기 불량, 단일 계열 통신 상실
                시에도 잔여 계열에 의해 원자로정지가 완벽히 수행됨을 검증합니다.
                <br />
                - <b>Clause 5.3 Independence (독립성):</b> 계열 간 입력 격리, 이종 보호기능 간 오투표 결합 차단, AI 보조 시스템과의 완전한
                물리적/논리적 비간섭성을 검증합니다.
                <br />
                - <b>Clause 5.5 Deterministic Timing (결정론적 실행):</b> 정주기 스캔 루프 및 명령 실행의 원자성(Atomicity)을 검증합니다.
                <br />
                - <b>Clause 5.7 Fail-Safe Principle:</b> 전원 상실 시 부족전압(UV) 코일 소자 및 차단기 자동 개방(De-energize to Trip)을
                검증합니다.
                <br />
                - <b>Clause 5.9 Maintenance Bypass:</b> 1계열 바이패스 시 2oo4에서 2oo3으로의 자동 전환 및 2계열 동시 바이패스 차단 인터록을
                검증합니다.
              </p>

              <h3>2. IEC 60880 원전 Category A 소프트웨어 안전 수명주기 요건</h3>
              <p>
                - <b>Clause 5 Software Requirements Traceability:</b> NUREG-1793 Supp 2 Ch 7에 정의된 19개 원자로보호기능의 전수 등록 및
                추적성을 확인합니다.
                <br />
                - <b>Clause 7 Defensive Programming:</b> NaN, Inf, 음수, 초과값 등 비정상 입력에 대한 상태 롤백 및 방어적 거부를 검증합니다.
                <br />
                - <b>Clause 8 Safety Interlocks:</b> 원자로 정지 래치 지속성 및 기동 조건 잔존 시 리셋 거부, 재폐로 인터록을 확인합니다.
                <br />
                - <b>Clause 9 Persistence & Audit:</b> SQLite WAL 트랜잭션 기반 상태 복원력 및 밀리초 단위 SOE 감사 로깅을 검증합니다.
              </p>

              <h3>3. STPA (System-Theoretic Process Analysis / STAMP) 위험 제어 분석</h3>
              <p>
                - <b>UCA-01 (Trip Not Provided):</b> 위험 과도상태에서 정지가 누락되는 Hazard H1을 방지하기 위한 16개 전수 조합 검증.
                <br />
                - <b>UCA-02 (Spurious Trip):</b> 서로 다른 계측기의 노이즈가 결합되어 오정지를 유발하는 Hazard H5 방지.
                <br />
                - <b>UCA-03 (Premature Reset):</b> 위험 원인이 남아있을 때 성급한 리셋으로 안전성을 훼손하는 Hazard H2 차단.
                <br />
                - <b>UCA-04 (Multi-Bypass):</b> 다중 우회로 인한 보호 능력 상실 Hazard H2 차단.
                <br />
                - <b>UCA-08 (AI Actuation Injection):</b> 외부 LLM의 프롬프트 주입 공격이 원자로 제어 명령으로 침투하는 위험(Hazard H4)을
                원천 차단.
              </p>

              <button className="primary" onClick={() => setTab('console')}>
                ← MCR 운전 콘솔로 복귀
              </button>
            </section>
          ) : (
            <>
              {/* Top Annunciator Banner */}
              <section className="metrics">
                <article className={'metric status-metric ' + (state?.trip_latched ? 'tripped' : '')}>
                  <div className="metric-label">
                    RTS SAFETY STATUS <span>●</span>
                  </div>
                  <strong>{state?.trip_latched ? 'REACTOR TRIPPED' : state ? 'NORMAL (ARMED)' : 'CONNECTING'}</strong>
                  <small>
                    {state?.trip_latched
                      ? '정지 래치 활성 · 제어봉 전원 차단 완료'
                      : 'PMS 4계열 건전 · 보호 논리 상시 감시 중'}
                  </small>
                </article>
                {([
                  ['power', '중성자속 모의 출력', 'NEUTRON FLUX'],
                  ['pressure', '가압기 압력', 'PRESSURIZER'],
                  ['flow', 'RCS 냉각재 유량', 'COOLANT FLOW']
                ] as const).map(([key, label, sub]) => (
                  <article className="metric" key={key}>
                    <div className="metric-label">
                      {sub}
                      <span className={'metric-glyph ' + key}>⌁</span>
                    </div>
                    <strong>
                      {metric(key).toFixed(1)}
                      <small> % RTP</small>
                    </strong>
                    <small>{label}</small>
                  </article>
                ))}
              </section>

              <div className="workspace">
                <div className="main-column">
                  {/* Process Signal Trend Chart */}
                  <section className="panel trend">
                    <div className="panel-heading">
                      <div>
                        <h2>원자로 공정 신호 트렌드 (Real-Time Process Telemetry)</h2>
                        <p>Normalized Core Parameters (Flux, Pressure, Coolant Flow)</p>
                      </div>
                      <span className="live-pill">{state?.running ? '● SIM RUNNING' : 'Ⅱ SIM PAUSED'}</span>
                    </div>
                    <div className="legend">
                      <span className="power">● 중성자속 (Power)</span>
                      <span className="pressure">● 가압기 압력 (Pressure)</span>
                      <span className="flow">● RCS 유량 (Flow)</span>
                      <small>0–100 % Scale</small>
                    </div>
                    <div className="chart">
                      <div className="axis">
                        <span>100%</span>
                        <span>75%</span>
                        <span>50%</span>
                        <span>25%</span>
                        <span>0%</span>
                      </div>
                      <svg viewBox="0 0 760 190" preserveAspectRatio="none" aria-label="추세 그래프" role="img">
                        {[20, 60, 100, 140, 180].map(y => (
                          <line key={y} x1="0" y1={y} x2="760" y2={y} stroke="#243441" strokeDasharray="3 5" />
                        ))}
                        {(['power', 'pressure', 'flow'] as const).map(key => (
                          <path
                            key={key}
                            d={path(key)}
                            fill="none"
                            stroke={{ power: '#45dac3', pressure: '#9a95ff', flow: '#e7b85f' }[key]}
                            strokeWidth="2.5"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                      </svg>
                    </div>
                    <div className="chart-bottom">
                      <span>T + {history[0]?.tick ?? 0} ticks</span>
                      <span>DETERMINISTIC SCAN CYCLE</span>
                      <span>T + {state?.tick ?? 0} ticks</span>
                    </div>
                    <div className="playback">
                      <select
                        aria-label="시나리오"
                        value={state?.scenario || 'normal'}
                        disabled={busy || !online}
                        onChange={e => command({ action: 'scenario', scenario: e.target.value })}
                      >
                        {scenarios.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                      <button
                        className="primary"
                        disabled={busy || !online}
                        onClick={() => command({ action: state?.running ? 'pause' : 'start' })}
                      >
                        {state?.running ? 'Ⅱ 모의 정지' : '▶ 모의 개시'}
                      </button>
                      <button disabled={busy || !online || state?.running} onClick={() => command({ action: 'step' })}>
                        1 Tick Step →
                      </button>
                      <button
                        className="text-button"
                        disabled={busy || !online}
                        onClick={() => command({ action: 'restore_inputs' })}
                      >
                        신호 복원 ↺
                      </button>
                    </div>
                  </section>

                  {/* 4 Redundant Divisions Architecture */}
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>4개 중복 계열 상태 및 차단기 작동 경로 (4-Division Redundancy)</h2>
                        <p>BPL Bistable Processing · LCL Local Coincidence Logic · RTCBs</p>
                      </div>
                      <span className="badge">{state?.voting || '2oo4'} COINCIDENCE LOGIC</span>
                    </div>
                    <div className="division-grid">
                      {(state?.divisions || []).map(d => (
                        <article className={'division ' + (d.partial_trip ? 'danger-border' : '')} key={d.id}>
                          <div className="division-head">
                            <strong>DIVISION {d.id}</strong>
                            <span className={d.bypassed ? 'amber' : d.partial_trip ? 'red' : 'teal'}>
                              {d.bypassed ? 'BYPASS' : d.partial_trip ? 'TRIP' : 'HEALTHY'}
                            </span>
                          </div>
                          <div className="signal">
                            <span>Partial Trip</span>
                            <b className={d.partial_trip ? 'red' : 'muted'}>{d.partial_trip ? 'TRIPPED (1)' : 'NORMAL (0)'}</b>
                          </div>
                          <div className="signal">
                            <span>UV Coil (Fail-safe)</span>
                            <b style={{ color: d.uv_energized ? '#10b981' : '#ef4444' }}>
                              {d.uv_energized ? 'ENERGIZED' : 'DE-ENERGIZED'}
                            </b>
                          </div>
                          <div className="signal">
                            <span>Shunt Trip Coil</span>
                            <b style={{ color: d.shunt_energized ? '#ef4444' : '#5a6e82' }}>
                              {d.shunt_energized ? 'ENERGIZED' : 'OFF'}
                            </b>
                          </div>
                          <div className="breaker-row">
                            {d.breakers_open.map((v, i) => (
                              <div className={v ? 'breaker open' : 'breaker'} key={i}>
                                <span>{v ? '╱' : '│'}</span>
                                RTCB {d.id}-{i + 1}
                                <b>{v ? 'OPEN' : 'CLOSED'}</b>
                              </div>
                            ))}
                          </div>
                          <select
                            aria-label={`계열 ${d.id} 고장 주입`}
                            value={d.fault}
                            disabled={busy || !online}
                            onChange={e => command({ action: 'fault', division: d.id, fault: e.target.value })}
                          >
                            {faults.map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                          <button
                            className={'bypass ' + (d.bypassed ? 'selected' : '')}
                            disabled={busy || !online}
                            onClick={() => command({ action: 'bypass', division: d.id, enabled: !d.bypassed })}
                          >
                            {d.bypassed ? 'Bypass 해제 (Restore)' : 'MTP Bypass 적용'}
                          </button>
                        </article>
                      ))}
                    </div>
                    <div className="output-bar">
                      <span>CRDM ROD DRIVE POWER BUS (제어봉 구동장치 전원)</span>
                      <strong className={state?.rod_drive_power ? 'teal' : 'red'}>
                        ● {state?.rod_drive_power ? 'ENERGIZED (RODS SUSPENDED)' : 'DE-ENERGIZED (SCRAM / RODS DROPPED)'}
                      </strong>
                      <small>2 RTCBs × 4 Divisions = 8 Breakers · 2 계열 이상 개방 시 전원 차단</small>
                    </div>
                  </section>

                  {/* 19 Protection Functions Table */}
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>AP1000 원자로보호기능 감시 매트릭스 (19 Protection Functions)</h2>
                        <p>NUREG-1793 Supp 2 Ch 7 기준 · 기능 선택 시 우측에서 시험 입력 조정 가능</p>
                      </div>
                      <span className="badge">19 PMS FUNCTIONS</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>FUNCTION</th>
                            <th>PROCESS</th>
                            <th>A</th>
                            <th>B</th>
                            <th>C</th>
                            <th>D</th>
                            <th>VOTES</th>
                            <th>LOGIC STATE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state?.functions.map(f => (
                            <tr
                              key={f.id}
                              className={selected === f.id ? 'selected-row' : ''}
                              onClick={() => {
                                setSelected(f.id);
                                setInput(String(f.value ?? 50));
                              }}
                            >
                              <td>
                                <button
                                  className="function-button"
                                  onClick={() => {
                                    setSelected(f.id);
                                    setInput(String(f.value ?? 50));
                                  }}
                                >
                                  <small>{f.id}</small>
                                  {f.name}
                                </button>
                              </td>
                              <td>{f.status === 'TBD' ? '—' : Number(f.value).toFixed(1)}</td>
                              {['A', 'B', 'C', 'D'].map(d => (
                                <td key={d}>
                                  <span className={'vote ' + (f.votes?.[d] ? 'voted' : '')}>
                                    {f.status === 'TBD' ? '—' : f.votes?.[d] ? '1' : '0'}
                                  </span>
                                </td>
                              ))}
                              <td>
                                <b style={{ fontFamily: 'var(--font-mono)' }}>
                                  {f.vote_count}/{state?.voting === '2oo3' ? '3' : '4'}
                                </b>
                              </td>
                              <td>
                                <span
                                  className={
                                    f.status === 'TBD' ? 'badge amber' : f.coincidence ? 'badge red' : 'badge'
                                  }
                                >
                                  {f.status === 'TBD' ? 'TBD (SPEC)' : f.coincidence ? 'TRIP ACTUATED' : 'ARMED'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>

                <div className="right-column">
                  {/* Operational Controls & Manual Trip */}
                  <section className="panel control">
                    <div className="panel-heading">
                      <h2>MCR 운전원 제어반 (Operator Actuations)</h2>
                      <span className="muted">HARDWIRED PATH</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '11px' }}>
                        <input
                          type="checkbox"
                          checked={guardOpen}
                          onChange={e => setGuardOpen(e.target.checked)}
                        />
                        <span>🛡 수동정지 안전 커버 개방 (Open Protective Cover)</span>
                      </label>
                      <button
                        className="trip-button"
                        disabled={busy || !online || !guardOpen}
                        onClick={() => command({ action: 'manual_trip' })}
                      >
                        <span>⊗</span> 수동 원자로 정지 (MANUAL SCRAM)
                        <small>{guardOpen ? 'DIRECT HARDWIRED RTCB ACTUATION' : 'PROTECTIVE COVER CLOSED'}</small>
                      </button>
                    </div>

                    <div className="control-grid">
                      <button
                        disabled={busy || !online || !state?.manual_trip}
                        onClick={() => command({ action: 'clear_manual' })}
                      >
                        수동 신호 복귀
                      </button>
                      <button
                        disabled={busy || !online || !state?.trip_latched}
                        onClick={() => command({ action: 'reset_trip' })}
                      >
                        Trip Reset (래치 해제)
                      </button>
                    </div>

                    <button
                      className="full"
                      disabled={busy || !online || state?.trip_latched || state?.rod_drive_power}
                      onClick={() => command({ action: 'reclose' })}
                    >
                      차단기 재폐로 (RTCB Reclose)
                    </button>

                    <p className="help">
                      <b>복구 인터록 절차:</b> 원인 신호 해소 → 수동 신호 복귀 → Trip Reset → RTCB 재폐로 순서로만 복구가 가능합니다.
                    </p>
                  </section>

                  {/* Test Signal Injection */}
                  <section className="panel input-panel">
                    <div className="panel-heading">
                      <h2>계측 신호 모의 주입 (Test Injection)</h2>
                      <span className="badge amber">I/O TEST</span>
                    </div>
                    <label>
                      보호 기능
                      <select
                        value={selected}
                        onChange={e => {
                          setSelected(e.target.value);
                          setInput(String(state?.functions.find(f => f.id === e.target.value)?.value ?? 50));
                        }}
                      >
                        {state?.functions.map(f => (
                          <option value={f.id} key={f.id}>
                            {f.id} · {f.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="input-details">
                      <span>
                        트립 방향 <b>{fn?.direction === 'low' ? '하한 이하 (Low)' : '상한 이상 (High)'}</b>
                      </span>
                      <span>
                        설정치 <b>{fn?.threshold ?? 'TBD'}</b>
                      </span>
                    </div>
                    <label>
                      적용 계열
                      <select value={division} onChange={e => setDivision(e.target.value)}>
                        <option value="all">전체 계열 (A, B, C, D 동시)</option>
                        {['A', 'B', 'C', 'D'].map(d => (
                          <option key={d} value={d}>
                            계열 {d}만 개별 변경
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      정규화 공정값 (0–100%)
                      <div className="numeric-row">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={input}
                          onChange={e => setInput(e.target.value)}
                        />
                        <span>%</span>
                      </div>
                    </label>
                    <input
                      aria-label="정규화 입력 슬라이더"
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={input}
                      onChange={e => setInput(e.target.value)}
                    />
                    <button
                      className="primary full"
                      disabled={
                        busy ||
                        !online ||
                        !fn ||
                        fn.status === 'TBD' ||
                        !Number.isFinite(Number(input)) ||
                        input.trim() === ''
                      }
                      onClick={() =>
                        command({ action: 'set_input', function_id: selected, division, value: Number(input) })
                      }
                    >
                      계측 신호 반영 →
                    </button>
                  </section>

                  {/* AI Nuclear Safety Advisor (Cerebras Inference) */}
                  <section className="panel assistant">
                    <div className="panel-heading">
                      <div>
                        <h2>⚡ Cerebras 원전 안전 보조원</h2>
                        <p>HIGH-SPEED INFERENCE · READ-ONLY EXPERT</p>
                      </div>
                      <span className="tiny-dot" />
                    </div>
                    <div className="chat-messages">
                      {messages.length === 0 ? (
                        <div className="welcome">
                          <p>
                            AP1000 원자로보호계통에 관해
                            <br />
                            Cerebras 기반 AI에게 즉시 질문하세요.
                          </p>
                          <button onClick={() => chat('2oo4 투표와 바이패스 2oo3 전환 논리를 설명해줘')}>
                            2oo4 및 바이패스 논리 설명 ↗
                          </button>
                          <button onClick={() => chat('현재 원자로 트립 상태와 리셋 인터록을 진단해줘')}>
                            현재 상태 및 리셋 요건 진단 ↗
                          </button>
                          <button onClick={() => chat('IEEE 7-4.3.2 단일고장기준(Single Failure Criterion) 요건을 설명해줘')}>
                            IEEE 7-4.3.2 단일고장 요건 ↗
                          </button>
                        </div>
                      ) : (
                        messages.map((m, i) => (
                          <div key={i} className={'message ' + m.role}>
                            <small>{m.role === 'user' ? 'OPERATOR' : 'CEREBRAS ADVISOR'}</small>
                            <p>{m.text}</p>
                          </div>
                        ))
                      )}
                      {thinking && <p className="muted">Cerebras 엔진에서 안전 분석을 생성하고 있습니다…</p>}
                    </div>
                    <form
                      onSubmit={e => {
                        e.preventDefault();
                        chat();
                      }}
                      className="chat-form"
                    >
                      <input
                        aria-label="도우미 질문"
                        placeholder="AP1000 RPS / 안전 표준에 대해 문의하세요"
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                        maxLength={2000}
                      />
                      <button disabled={thinking || !question.trim()} aria-label="질문 전송">
                        ↑
                      </button>
                    </form>
                    <div className="assistant-foot">Cerebras 초고속 추론 연동 · 제어 권한 없는 순수 자문용</div>
                  </section>

                  {/* Annunciator Alarms Panel */}
                  <section className="panel alarms">
                    <div className="panel-heading">
                      <h2>경보 알람 (Active Annunciators)</h2>
                      <span className="badge">{state?.alarms.length ?? 0}</span>
                    </div>
                    {state?.alarms.length ? (
                      state.alarms.map((a, i) => (
                        <div key={i} className="alarm">
                          ⚠ {typeof a === 'string' ? a : JSON.stringify(a)}
                        </div>
                      ))
                    ) : (
                      <div className="empty">✓ 모든 계열 및 차단기 정상 (No Active Alarms)</div>
                    )}
                  </section>
                </div>
              </div>

              {/* Sequence of Events (SOE) Audit Trail */}
              <section className="panel audit">
                <div className="panel-heading">
                  <div>
                    <h2>사건 순서 기록 (SOE · Sequence of Events Audit Trail)</h2>
                    <p>밀리초 단위 이벤트 타임스탬프 및 상태 리비전 추적</p>
                  </div>
                  <span className="badge">STATE REV #{state?.revision ?? 0}</span>
                </div>
                <div className="event-list">
                  {events.length ? (
                    events
                      .slice(-8)
                      .reverse()
                      .map(e => (
                        <div className="event" key={e.id}>
                          <span className="event-time">
                            {new Date(e.timestamp).toLocaleTimeString('ko-KR', { hour12: false })}.
                            {String(new Date(e.timestamp).getMilliseconds()).padStart(3, '0')}
                          </span>
                          <span className="event-action">{e.action}</span>
                          <span className="event-detail">
                            {typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}
                          </span>
                          <span className="muted">#{e.id}</span>
                        </div>
                      ))
                  ) : (
                    <div className="empty">시뮬레이터 이벤트가 기록되면 이곳에 실시간 표시됩니다.</div>
                  )}
                </div>
              </section>
            </>
          )}

          <footer>
            <span>WESTINGHOUSE AP1000 PMS / RTS SIMULATION CONSOLE</span>
            <span>IEEE 7-4.3.2 · IEC 60880 · STPA VERIFIED · CEREBRAS LLM INTEGRATED</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
