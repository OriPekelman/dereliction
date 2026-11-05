"""Headless smoke test: loads the playground and the live demo on a software GL renderer and checks
there are no JS errors, the sim runs, presets apply, and attach() overlays and exits.
Requires the capture server on http://localhost:8008 (uv run server.py)."""
import json
import sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8008"
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
failures = []

def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=ARGS)
    errors = []
    def wire(pg):
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)

    pg = b.new_page(viewport={"width": 1400, "height": 900}); wire(pg)
    pg.goto(f"{BASE}/web/", wait_until="load"); pg.wait_for_timeout(1500)
    st = pg.evaluate("DR.sim.stats")
    check(st["particles"] > 500000 and st["bodies"] > 5, f"playground demo loaded: {st}")
    for name in ["Avalanche", "Hourglass", "Letter pile", "Reassemble"]:
        pg.click(f"#presets button:text-is('{name}')"); pg.wait_for_timeout(1200)
        check(pg.evaluate("DR.sim.presetName") == name, f"preset {name} applies")
    check(pg.evaluate("DR.sim.stats.fps") > 0, "sim is rendering frames")
    pg.click("#self"); pg.wait_for_timeout(8000)
    check("client-side capture" in (pg.text_content("#status") or ""), "client-side DOM capture works: " + (pg.text_content("#status") or ""))
    # --physics roles fixture through the server capture: frame = compound body with words inside it
    fx = pg.evaluate("""async () => {
      const s = await Dereliction.captureServer({ endpoint: '/capture', url: location.origin + '/web/physics-test.html', width: 900, height: 900 });
      DR.sim.load(s); DR.sim.applyPreset('Avalanche');
      const frames = DR.sim.bodies.filter(b => b.plugin.home.role === 3);
      const f = frames[0]; const h = f && f.plugin.home;
      const wordsInside = h ? DR.sim.bodies.filter(b => (b.plugin.home.type === 1 || b.plugin.home.type === 3) && b.plugin.home.x > h.x - h.w/2 && b.plugin.home.x < h.x + h.w/2 && b.plugin.home.y > h.y - h.h/2 && b.plugin.home.y < h.y + h.h/2).length : 0;
      await new Promise(r => setTimeout(r, 2500));
      return { shapes: s.shapes.length, roles: s.shapes.map(x => x[4]), frames: frames.length, parts: f ? f.parts.length : 0, wordsInside, fell: f ? f.position.y - h.y : 0, solidStill: DR.sim.bodies.filter(b => b.plugin.home.role === 1).every(b => b.isStatic) };
    }""")
    check(fx["frames"] == 1 and fx["parts"] == 5 and fx["wordsInside"] >= 5 and fx["fell"] > 5 and fx["solidStill"], f"frame role: {json.dumps(fx)}")
    pg.close()

    pg = b.new_page(viewport={"width": 1280, "height": 800}); wire(pg)
    pg.goto(f"{BASE}/web/live-demo.html", wait_until="load"); pg.wait_for_timeout(9000)
    info = pg.evaluate("() => ({ active: ctl.active, overlay: !!document.querySelector('.dereliction-overlay'), preset: ctl.sim && ctl.sim.presetName, bodies: ctl.sim && ctl.sim.stats.bodies })")
    check(info["active"] and info["overlay"] and info["preset"] == "Avalanche" and info["bodies"] > 50, f"attach() started after idle: {json.dumps(info)}")
    pg.mouse.move(600, 400); pg.mouse.wheel(0, 50); pg.wait_for_timeout(300)
    check(pg.evaluate("ctl.sim && ctl.sim.presetName") == "Reassemble", "wheel triggers reassemble")
    pg.wait_for_timeout(3500)
    check(not pg.evaluate("ctl.active") and not pg.evaluate("!!document.querySelector('.dereliction-overlay')"), "overlay removed after exit")
    pg.close()

    # root demo page (GitHub Pages): buttons, keys, Esc, honest idle status
    pg = b.new_page(viewport={"width": 1280, "height": 800}); wire(pg)
    pg.goto(f"{BASE}/index.html", wait_until="load"); pg.wait_for_timeout(500)
    idle = pg.text_content("#status") or ""
    check(idle and "1–5" not in idle and "presets" not in idle, f"idle status offers no keys: {idle}")
    pg.click("#presets button[data-preset='Melt']")
    try:  # poll for Melt (the click clears the idle timer, so a long wait cannot be satisfied by Avalanche)
        pg.wait_for_function("ctl.active && ctl.sim && ctl.sim.presetName === 'Melt'", timeout=9000)
    except Exception:
        pass
    root = pg.evaluate("() => ({ active: ctl.active, preset: ctl.sim && ctl.sim.presetName })")
    check(root["active"] and root["preset"] == "Melt", f"root demo: Melt button starts the effect: {json.dumps(root)}")
    pg.keyboard.press("2"); pg.wait_for_timeout(300)
    check(pg.evaluate("ctl.sim && ctl.sim.presetName") == "Letter pile", "root demo: key 2 switches to Letter pile")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check(pg.evaluate("ctl.sim && ctl.sim.presetName") == "Reassemble", "root demo: Esc reassembles")
    pg.wait_for_timeout(3500)
    check(not pg.evaluate("ctl.active") and not pg.evaluate("!!document.querySelector('.dereliction-overlay')"), "root demo: overlay removed after Esc")
    pg.close()

    # zero-config: bundled build + data-attach attributes, no other script on the page
    pg = b.new_page(viewport={"width": 1100, "height": 760}); wire(pg)
    pg.goto(f"{BASE}/web/auto-demo.html", wait_until="load"); pg.wait_for_timeout(8000)
    auto = pg.evaluate("() => ({ bundled: !!(window.Matter && window.html2canvas), auto: !!Dereliction.auto, active: !!(Dereliction.auto && Dereliction.auto.active), preset: Dereliction.auto && Dereliction.auto.sim && Dereliction.auto.sim.presetName, frames: Dereliction.auto && Dereliction.auto.sim ? Dereliction.auto.sim.bodies.filter(b => b.plugin.home.role === 3).length : 0 })")
    check(auto["bundled"] and auto["active"] and auto["preset"] == "Avalanche" and auto["frames"] == 1, f"zero-config bundle + data-attach: {json.dumps(auto)}")
    pg.close()
    b.close()

check(not errors, "no JS errors" if not errors else "JS errors: " + " | ".join(errors[:5]))
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
