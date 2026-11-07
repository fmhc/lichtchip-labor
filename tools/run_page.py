"""Open a page in headless Chromium with WebGPU (Vulkan), wait for document.title to start with DONE/OK/ERR,
print the text of #out (or body), save a screenshot. Runs on the test host only.
usage: run_page.py URL OUT.png [timeout_s] [WIDTHxHEIGHT[@DPR]]"""
import sys, time, math, re
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright
from browser_checks import prepare, run
url, png = sys.argv[1], sys.argv[2]
timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 120
viewport_arg = sys.argv[4] if len(sys.argv) > 4 else "1500x950"
size, _, scale = viewport_arg.partition("@")
width, height = map(int, size.split("x"))
dpr = float(scale) if scale else 1
if not (math.isfinite(timeout) and 1 <= timeout <= 3600 and 320 <= width <= 3840
        and 320 <= height <= 2160 and math.isfinite(dpr) and 1 <= dpr <= 3.9):
    raise ValueError('Invalid timeout or viewport')
if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*\.png', png):
    raise ValueError('Invalid screenshot name')
parts = urlsplit(url)
if parts.scheme != 'http' or parts.hostname != 'localhost':
    raise ValueError('Only the local test server is allowed')
query = parse_qs(parts.query, keep_blank_values=True)
scenario = query.get('checks', [''])[0]
if scenario and scenario not in ('nogpu', 'lost', 'validation', 'lifecycle'):
    raise ValueError('Unknown checks scenario')
expected = ('DONE diag' if 'diag' in query else 'PASS selftest' if 'selftest' in query
            else 'DONE sweep' if 'sweep' in query or 'control' in query else 'DONE spectrum' if 'spectrum' in query
            else 'DONE steps' if 'steps' in query else 'OK')
if scenario:
    expected = 'PASS checks' if scenario == 'lifecycle' else 'ERR webgpu'
args = ["--enable-unsafe-webgpu", "--enable-features=Vulkan,VulkanFromANGLE", "--use-angle=vulkan",
        "--ignore-gpu-blocklist", "--enable-gpu", "--disable-dev-shm-usage"]
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=args)
    pg = b.new_page(viewport={"width": width, "height": height}, device_scale_factor=dpr)
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    prepare(pg, scenario)
    pg.goto(url)
    t0 = time.time()
    scenario_pass = True
    if scenario:
        try:
            print(run(pg, scenario))
        except Exception as error:
            scenario_pass = False
            print('CHECK FAILED:', error)
            pg.evaluate("document.title = 'FAIL checks'")
    while time.time() - t0 < timeout:
        t = pg.title()
        if t.startswith(("DONE", "OK", "ERR", "FAIL", "PASS")):
            break
        time.sleep(0.5)
    title = pg.title()
    success = (title == expected and not title.startswith(('ERR', 'FAIL')) and scenario_pass
               and not any(line.startswith('[pageerror]') for line in logs))
    print("TITLE:", title, f"({time.time()-t0:.1f}s)")
    for sel in ["#out", "#specState", "#swState", "#status"]:
        el = pg.query_selector(sel)
        if el and el.inner_text().strip():
            print(sel, el.inner_text()[:20000])
    print("LAYOUT:", pg.evaluate("""() => ({viewport: innerWidth, document: document.documentElement.scrollWidth,
        dpr: devicePixelRatio, plots: [...document.querySelectorAll('.plots canvas')].map(c => ({id: c.id,
        pixels: c.width, css: c.getBoundingClientRect().width}))})"""))
    pg.screenshot(path=png, full_page=True)
    print("\n".join(logs[-40:]))
    b.close()
sys.exit(0 if success else 1)
