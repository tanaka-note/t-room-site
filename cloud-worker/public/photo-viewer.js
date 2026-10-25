(() => {
  "use strict";

  // All image transforms stay in the page. This module never fetches files or keys.
  function attach(stage, image, { onNavigate, onChange = () => {} }) {
    const controller = new AbortController();
    const pointers = new Map();
    let scale = 1, x = 0, y = 0, gesture = null, lastTap = null;
    let destroyed = false, lastPointerType = "mouse";
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const point = event => ({ x: event.clientX, y: event.clientY });
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    function render() {
      if (destroyed) return;
      const bounds = stage.getBoundingClientRect();
      const fit = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
      const maxX = Math.max(0, (image.naturalWidth * fit * scale - bounds.width) / 2);
      const maxY = Math.max(0, (image.naturalHeight * fit * scale - bounds.height) / 2);
      x = clamp(x, -maxX, maxX); y = clamp(y, -maxY, maxY);
      image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      stage.classList.toggle("is-photo-zoomed", scale > 1);
      onChange(scale);
    }
    function zoom(next, focal) {
      const bounds = stage.getBoundingClientRect();
      const at = focal || { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      next = clamp(next, 1, 6);
      const ratio = next / scale;
      x = (at.x - bounds.left - bounds.width / 2) * (1 - ratio) + x * ratio;
      y = (at.y - bounds.top - bounds.height / 2) * (1 - ratio) + y * ratio;
      scale = next;
      render();
    }
    function start(event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      lastPointerType = event.pointerType;
      event.preventDefault();
      pointers.set(event.pointerId, point(event));
      try { stage.setPointerCapture(event.pointerId); } catch {}
      if (pointers.size === 1) {
        gesture = { start: point(event), originX: x, originY: y, scale, moved: false, multi: false, time: performance.now() };
      } else {
        gesture.multi = true; lastTap = null;
        const [a, b] = [...pointers.values()];
        gesture.pinch = { distance: Math.max(1, distance(a, b)), center: midpoint(a, b), scale, x, y };
      }
    }
    function move(event) {
      if (!pointers.has(event.pointerId) || !gesture) return;
      event.preventDefault();
      pointers.set(event.pointerId, point(event));
      if (distance(gesture.start, point(event)) > 8) gesture.moved = true;
      if (pointers.size >= 2 && gesture.pinch) {
        const [a, b] = [...pointers.values()], pinch = gesture.pinch;
        const center = midpoint(a, b), bounds = stage.getBoundingClientRect();
        scale = clamp(pinch.scale * distance(a, b) / pinch.distance, 1, 6);
        const ratio = scale / pinch.scale;
        x = center.x - bounds.left - bounds.width / 2 - (pinch.center.x - bounds.left - bounds.width / 2 - pinch.x) * ratio;
        y = center.y - bounds.top - bounds.height / 2 - (pinch.center.y - bounds.top - bounds.height / 2 - pinch.y) * ratio;
        render();
      } else if (scale > 1) {
        x = gesture.originX + event.clientX - gesture.start.x;
        y = gesture.originY + event.clientY - gesture.start.y;
        render();
      }
    }
    function end(event) {
      if (!pointers.has(event.pointerId) || !gesture) return;
      event.preventDefault();
      pointers.delete(event.pointerId);
      try { stage.releasePointerCapture(event.pointerId); } catch {}
      if (event.type === "pointercancel") { gesture.multi = true; lastTap = null; }
      if (pointers.size) {
        const remaining = [...pointers.values()][0];
        gesture.start = remaining; gesture.originX = x; gesture.originY = y;
        return;
      }
      const finished = gesture; gesture = null;
      if (finished.multi || event.type === "pointercancel") return;
      const dx = event.clientX - finished.start.x, dy = event.clientY - finished.start.y;
      if (event.pointerType !== "mouse" && finished.scale === 1 && scale === 1 && Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        lastTap = null; onNavigate(dx < 0 ? 1 : -1); return;
      }
      if (finished.moved || Math.hypot(dx, dy) > 8 || performance.now() - finished.time > 350) { lastTap = null; return; }
      if (event.pointerType === "mouse") return;
      const now = performance.now(), at = point(event);
      if (lastTap && now - lastTap.time < 320 && distance(lastTap, at) < 30) {
        lastTap = null; zoom(scale > 1 ? 1 : 2.5, at);
      } else lastTap = { ...at, time: now };
    }
    for (const [type, handler] of [["pointerdown", start], ["pointermove", move], ["pointerup", end], ["pointercancel", end]]) {
      stage.addEventListener(type, handler, { signal: controller.signal });
    }
    stage.addEventListener("dblclick", event => {
      event.preventDefault();
      if (lastPointerType === "mouse") zoom(scale > 1 ? 1 : 2.5, point(event));
    }, { signal: controller.signal });
    stage.addEventListener("dragstart", event => event.preventDefault(), { signal: controller.signal });
    stage.addEventListener("lostpointercapture", event => {
      if (!pointers.has(event.pointerId)) return;
      pointers.clear(); gesture = null; lastTap = null;
    }, { signal: controller.signal });
    const observer = new ResizeObserver(render);
    observer.observe(stage);
    render();
    return Object.freeze({
      toggle: () => zoom(scale > 1 ? 1 : 2.5),
      replaceImage(nextImage) {
        image.style.removeProperty("transform");
        image = nextImage;
        render();
      },
      destroy() {
        destroyed = true; controller.abort(); observer.disconnect();
        for (const id of pointers.keys()) { try { stage.releasePointerCapture(id); } catch {} }
        pointers.clear(); gesture = null; lastTap = null;
        image.style.removeProperty("transform");
        stage.classList.remove("is-photo-zoomed");
      }
    });
  }
  globalThis.TCloudPhotoViewer = Object.freeze({ attach });
})();
