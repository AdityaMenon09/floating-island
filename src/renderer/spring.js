// Damped springs for UI motion, parameterised the way SwiftUI does it:
//   response  the period of the undamped oscillation, in seconds (lower = snappier)
//   damping   the damping fraction (1 = settles without overshoot, < 1 = a little bounce)
// A spring keeps its velocity when you give it a new target, so interrupting an animation
// (opening while it is still closing) bends the motion instead of restarting it.
(function () {
  const running = new Set();
  let rafId = 0;
  let last = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  class Spring {
    constructor(values, { response = 0.45, damping = 0.85, precision = 0.1, onUpdate } = {}) {
      this.value = { ...values };
      this.target = { ...values };
      this.velocity = {};
      for (const k in values) this.velocity[k] = 0;
      this.response = response;
      this.damping = damping;
      this.precision = precision;
      this.onUpdate = onUpdate;
    }

    to(target, { response, damping, velocity } = {}) {
      Object.assign(this.target, target);
      for (const k in target) if (!(k in this.value)) { this.value[k] = target[k]; this.velocity[k] = 0; }
      if (response) this.response = response;
      if (damping != null) this.damping = damping;
      if (velocity) Object.assign(this.velocity, velocity);
      running.add(this);
      wake();
      return this;
    }

    jump(values) {
      Object.assign(this.value, values);
      Object.assign(this.target, values);
      for (const k in values) this.velocity[k] = 0;
      if (this.onUpdate) this.onUpdate(this.value);
      return this;
    }

    get moving() { return running.has(this); }

    step(dt) {
      const response = reduced.matches ? 0.22 : this.response;
      const damping = reduced.matches ? 1 : this.damping;
      const stiffness = (2 * Math.PI / response) ** 2;
      const friction = (4 * Math.PI * damping) / response;
      // Semi-implicit Euler in small fixed steps: stable for stiff springs at any frame rate.
      const n = Math.max(1, Math.ceil(dt * 240));
      const h = dt / n;
      let settled = true;
      for (const k in this.target) {
        let x = this.value[k];
        let v = this.velocity[k];
        const to = this.target[k];
        for (let i = 0; i < n; i++) {
          v += (-stiffness * (x - to) - friction * v) * h;
          x += v * h;
        }
        if (Math.abs(x - to) > this.precision || Math.abs(v) > this.precision * 10) settled = false;
        this.value[k] = x;
        this.velocity[k] = v;
      }
      if (settled) {
        for (const k in this.target) { this.value[k] = this.target[k]; this.velocity[k] = 0; }
      }
      return !settled;
    }
  }

  function frame(now) {
    // Catch up after a slow frame instead of slowing the motion down (the sub-steps keep this
    // stable); only a long stall, like a hidden window, is cut short.
    const dt = last ? Math.min((now - last) / 1000, 0.25) : 1 / 60;
    last = now;
    for (const s of running) {
      if (!s.step(dt)) running.delete(s);
      if (s.onUpdate) s.onUpdate(s.value);
    }
    if (running.size) {
      rafId = requestAnimationFrame(frame);
    } else {
      rafId = 0;
      last = 0;
    }
  }

  function wake() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  // The same spring as a CSS `linear()` easing, for things CSS animates (fades, presses, hovers).
  function springEasing(response, damping, samples = 40) {
    const stiffness = (2 * Math.PI / response) ** 2;
    const friction = (4 * Math.PI * damping) / response;
    const h = 1 / 600;
    const points = [];
    let x = 0, v = 0, t = 0, still = 0;
    while (t < 3) {
      v += (-stiffness * (x - 1) - friction * v) * h;
      x += v * h;
      t += h;
      points.push(x);
      still = Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.02 ? still + 1 : 0;
      if (still > 30) break;
    }
    const out = [];
    for (let i = 0; i <= samples; i++) {
      const p = points[Math.min(points.length - 1, Math.round((i / samples) * (points.length - 1)))];
      out.push(+p.toFixed(4));
    }
    out[out.length - 1] = 1;
    return { easing: `linear(${out.join(', ')})`, duration: Math.round(t * 1000) };
  }

  window.Spring = Spring;
  window.springEasing = springEasing;
})();
