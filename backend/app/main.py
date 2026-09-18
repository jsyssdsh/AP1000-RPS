import asyncio
import json
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from .engine import Simulator, catalog

db_path = os.environ.get('DB_PATH', os.environ.get('RPS_DB_PATH', '/tmp/rps.sqlite3' if os.name != 'nt' else 'rps.sqlite3'))
Path(db_path).parent.mkdir(parents=True, exist_ok=True)
simulator = Simulator(db_path)

async def advance():
    while True:
        await asyncio.sleep(1)
        if simulator.state()['running']:
            simulator.command({'action': 'step'})

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.simulator = simulator
    task = asyncio.create_task(advance())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

app = FastAPI(title='AP1000 RPS Simulator & Nuclear Safety System', lifespan=lifespan)
app.state.simulator = simulator

@app.get('/api/health')
def health():
    return {'status': 'ok', 'mode': 'educational-simulator', 'system': 'AP1000 PMS/RTS'}

@app.get('/api/state')
def state():
    return simulator.state()

@app.get('/api/catalog')
def get_catalog():
    return catalog()

@app.get('/api/events')
def events():
    return simulator.events()

@app.post('/api/command')
def command(body: dict):
    try:
        return simulator.command(body)
    except (ValueError, TypeError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

@app.get('/api/stream')
async def stream():
    async def generate():
        while True:
            yield 'data: ' + json.dumps(simulator.state(), ensure_ascii=False) + '\n\n'
            await asyncio.sleep(1)
    return StreamingResponse(
        generate(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )

@app.get('/api/safety-tests')
def run_safety_tests():
    """Execute IEEE 7-4.3.2, IEC 60880, and STPA test suites and return structured verification results."""
    base_dir = Path(__file__).resolve().parent.parent
    test_files = [
        ("IEEE 7-4.3.2", str(base_dir / "tests" / "test_ieee_7_4_3_2.py")),
        ("IEC 60880", str(base_dir / "tests" / "test_iec_60880.py")),
        ("STPA (STAMP)", str(base_dir / "tests" / "test_stpa.py"))
    ]
    
    results = {
        "status": "passed",
        "total_passed": 0,
        "total_failed": 0,
        "suites": []
    }
    
    for standard_name, file_path in test_files:
        try:
            cmd = [sys.executable, "-m", "pytest", file_path, "-q", "--tb=short"]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            output = proc.stdout.strip()
            passed = proc.returncode == 0
            
            # Parse test counts from output like "15 passed in 0.20s"
            summary = output.splitlines()[-1] if output.splitlines() else "Unknown"
            count = 0
            if "passed" in summary:
                words = summary.split()
                if words and words[0].isdigit():
                    count = int(words[0])
            
            results["suites"].append({
                "name": standard_name,
                "file": file_path,
                "passed": passed,
                "count": count,
                "summary": summary,
                "returncode": proc.returncode
            })
            if passed:
                results["total_passed"] += count
            else:
                results["total_failed"] += 1
                results["status"] = "failed"
        except Exception as err:
            results["suites"].append({
                "name": standard_name,
                "file": file_path,
                "passed": False,
                "count": 0,
                "summary": str(err),
                "returncode": -1
            })
            results["total_failed"] += 1
            results["status"] = "failed"
            
    return results

try:
    from .assistant import router
    app.include_router(router)
except ImportError:
    pass

# Serve compiled frontend static files
for candidate in [
    os.environ.get('STATIC_DIR'),
    os.environ.get('RPS_STATIC_DIR'),
    'frontend/out',
    'frontend/dist',
    'static'
]:
    if candidate:
        p = Path(candidate)
        if p.is_dir():
            app.mount('/', StaticFiles(directory=str(p), html=True), name='frontend')
            break
