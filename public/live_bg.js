/**
 * OpenCode Studio — Lightweight 60fps Canvas Live Wallpapers Engine.
 * Supports 6 curated procedural animated backgrounds with automatic pause on hidden tab.
 */

(() => {
  "use strict";

  class LiveWallpaperEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.mode = "";
      this.raf = null;
      this.t = 0;
      this.particles = [];
      this.drops = [];
      this._onResize = () => this.resize();
      window.addEventListener("resize", this._onResize);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.pauseLoop();
        else if (this.mode) this.startLoop();
      });
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;
      this._seedEntities();
    }

    _seedEntities() {
      this.particles = [];
      const count = this.mode === "live-starfield" ? 130 : 58;
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          vx: (Math.random() - 0.5) * (this.mode === "live-starfield" ? 0.25 : 0.45),
          vy: (Math.random() - 0.5) * (this.mode === "live-starfield" ? 0.25 : 0.45),
          r: Math.random() * 2 + 0.6,
          a: Math.random() * 0.7 + 0.25,
          phase: Math.random() * Math.PI * 2,
        });
      }
      const cols = Math.ceil(this.w / 22);
      this.drops = Array.from({ length: cols }, () => Math.random() * -40);
    }

    setMode(mode) {
      this.mode = mode || "";
      if (!this.mode) {
        this.pauseLoop();
        this.canvas.classList.add("hidden");
        return;
      }
      this.canvas.classList.remove("hidden");
      this.resize();
      this.startLoop();
    }

    pauseLoop() {
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
    }

    startLoop() {
      if (this.raf || !this.mode) return;
      const tick = () => {
        this.t += 0.012;
        this.draw();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }

    draw() {
      const { ctx, w, h, t, mode } = this;
      if (mode === "live-aurora") {
        const bg = ctx.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, "#0b1320");
        bg.addColorStop(1, "#122136");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        const bands = [
          { y: h * 0.34, amp: 55, speed: 0.9, c1: "rgba(34, 211, 238, 0.26)", c2: "rgba(16, 185, 129, 0.04)" },
          { y: h * 0.52, amp: 70, speed: 0.65, c1: "rgba(99, 102, 241, 0.25)", c2: "rgba(56, 189, 248, 0.03)" },
          { y: h * 0.68, amp: 48, speed: 1.15, c1: "rgba(16, 185, 129, 0.2)", c2: "rgba(15, 23, 42, 0)" },
        ];
        for (const b of bands) {
          ctx.beginPath();
          ctx.moveTo(0, h);
          for (let x = 0; x <= w; x += 28) {
            const y = b.y + Math.sin(x * 0.0045 + t * b.speed) * b.amp + Math.cos(x * 0.002 - t * 0.6) * 28;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          const g = ctx.createLinearGradient(0, b.y - 90, 0, h);
          g.addColorStop(0, b.c1);
          g.addColorStop(1, b.c2);
          ctx.fillStyle = g;
          ctx.fill();
        }
      } else if (mode === "live-starfield") {
        const g = ctx.createRadialGradient(w * 0.35, h * 0.25, 10, w * 0.5, h * 0.5, Math.max(w, h));
        g.addColorStop(0, "#172540");
        g.addColorStop(0.55, "#0b1120");
        g.addColorStop(1, "#05070d");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);

        for (const p of this.particles) {
          p.x = (p.x + p.vx + w) % w;
          p.y = (p.y + p.vy + h) % h;
          const tw = 0.45 + 0.55 * Math.sin(t * 2.2 + p.phase);
          ctx.fillStyle = `rgba(226, 238, 255, ${(p.a * tw).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (mode === "live-mesh") {
        ctx.fillStyle = "#f2f5fa";
        ctx.fillRect(0, 0, w, h);
        const blobs = [
          { cx: w * (0.25 + 0.16 * Math.sin(t * 0.5)), cy: h * (0.3 + 0.14 * Math.cos(t * 0.4)), r: w * 0.42, color: "rgba(147, 197, 253, 0.45)" },
          { cx: w * (0.76 + 0.14 * Math.cos(t * 0.45)), cy: h * (0.35 + 0.15 * Math.sin(t * 0.55)), r: w * 0.38, color: "rgba(196, 181, 253, 0.4)" },
          { cx: w * (0.52 + 0.18 * Math.sin(t * 0.35 + 2)), cy: h * (0.76 + 0.12 * Math.cos(t * 0.4)), r: w * 0.44, color: "rgba(167, 243, 208, 0.38)" },
        ];
        for (const b of blobs) {
          const g = ctx.createRadialGradient(b.cx, b.cy, 0, b.cx, b.cy, b.r);
          g.addColorStop(0, b.color);
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
        }
      } else if (mode === "live-waves") {
        const bg = ctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, "#0c1d33");
        bg.addColorStop(1, "#092a38");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        for (let layer = 0; layer < 4; layer++) {
          ctx.beginPath();
          const baseY = h * (0.42 + layer * 0.14);
          ctx.moveTo(0, h);
          for (let x = 0; x <= w; x += 24) {
            const y = baseY + Math.sin(x * 0.0055 + t * (0.7 + layer * 0.25) + layer) * (24 + layer * 8);
            ctx.lineTo(x, y);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fillStyle = `rgba(56, 189, 248, ${(0.08 + layer * 0.045).toFixed(3)})`;
          ctx.fill();
        }
      } else if (mode === "live-constellation") {
        ctx.fillStyle = "#101827";
        ctx.fillRect(0, 0, w, h);
        for (const p of this.particles) {
          p.x = (p.x + p.vx + w) % w;
          p.y = (p.y + p.vy + h) % h;
        }
        ctx.lineWidth = 0.8;
        for (let i = 0; i < this.particles.length; i++) {
          const a = this.particles[i];
          ctx.fillStyle = "rgba(148, 197, 255, 0.72)";
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r + 0.5, 0, Math.PI * 2);
          ctx.fill();
          for (let j = i + 1; j < this.particles.length; j++) {
            const b = this.particles[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 135) {
              ctx.strokeStyle = `rgba(96, 165, 250, ${((1 - dist / 135) * 0.32).toFixed(2)})`;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
        }
      } else if (mode === "live-matrix") {
        ctx.fillStyle = "rgba(7, 15, 11, 0.14)";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "rgba(52, 211, 153, 0.55)";
        ctx.font = "13px monospace";
        const chars = "01{}[]<>/=*+-;:ClaudeCode";
        for (let i = 0; i < this.drops.length; i++) {
          const ch = chars[Math.floor(Math.random() * chars.length)];
          ctx.fillText(ch, i * 22, this.drops[i] * 20);
          if (this.drops[i] * 20 > h && Math.random() > 0.975) this.drops[i] = 0;
          this.drops[i] += 0.45;
        }
      } else if (mode === "live-sakura") {
        const bg = ctx.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, "#fdf2f8");
        bg.addColorStop(0.55, "#fce7f3");
        bg.addColorStop(1, "#e8f0f2");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        for (const p of this.particles) {
          p.x = (p.x + 0.55 + Math.sin(t + p.phase) * 0.45 + w) % w;
          p.y = (p.y + 0.65 + p.r * 0.25) % h;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(t * 0.8 + p.phase);
          ctx.fillStyle = `rgba(244, 143, 177, ${(0.35 + p.a * 0.45).toFixed(2)})`;
          ctx.beginPath();
          ctx.ellipse(0, 0, p.r * 3.1, p.r * 1.5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      } else if (mode === "live-rain") {
        const bg = ctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, "#10203a");
        bg.addColorStop(1, "#1e3a5f");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = "rgba(186, 230, 253, 0.32)";
        ctx.lineWidth = 1.1;
        for (const p of this.particles) {
          p.x = (p.x - 0.8 + w) % w;
          p.y = (p.y + 4.5 + p.r * 2.2) % h;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - 4, p.y + 14 + p.r * 4);
          ctx.stroke();
        }
        // Subtle water ripples
        for (let i = 0; i < 6; i++) {
          const prog = (t * 0.35 + i * 0.17) % 1;
          const rx = ((i * 239 + 110) % Math.max(w, 1));
          const ry = h * (0.68 + (i % 3) * 0.09);
          ctx.strokeStyle = `rgba(147, 197, 253, ${((1 - prog) * 0.28).toFixed(2)})`;
          ctx.beginPath();
          ctx.ellipse(rx, ry, prog * 54, prog * 14, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (mode === "live-nebula") {
        ctx.fillStyle = "#090a1a";
        ctx.fillRect(0, 0, w, h);
        const clouds = [
          { cx: w * (0.3 + 0.12 * Math.sin(t * 0.35)), cy: h * 0.38, r: w * 0.45, c: "rgba(139, 92, 246, 0.34)" },
          { cx: w * (0.72 + 0.12 * Math.cos(t * 0.3)), cy: h * 0.56, r: w * 0.42, c: "rgba(236, 72, 153, 0.26)" },
          { cx: w * (0.5 + 0.15 * Math.sin(t * 0.45 + 1.5)), cy: h * 0.65, r: w * 0.36, c: "rgba(251, 191, 36, 0.16)" },
        ];
        for (const cl of clouds) {
          const g = ctx.createRadialGradient(cl.cx, cl.cy, 0, cl.cx, cl.cy, cl.r);
          g.addColorStop(0, cl.c);
          g.addColorStop(1, "rgba(9,10,26,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
        }
        for (const p of this.particles) {
          p.x = (p.x + p.vx * 0.7 + w) % w;
          p.y = (p.y + p.vy * 0.7 + h) % h;
          const tw = 0.4 + 0.6 * Math.sin(t * 2 + p.phase);
          ctx.fillStyle = `rgba(254, 243, 199, ${(p.a * tw).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (mode === "live-ink") {
        const bg = ctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, "#f5f7f8");
        bg.addColorStop(0.55, "#e4eaee");
        bg.addColorStop(1, "#cfd8dc");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        for (let layer = 0; layer < 4; layer++) {
          ctx.beginPath();
          const baseY = h * (0.52 + layer * 0.11);
          ctx.moveTo(0, h);
          for (let x = 0; x <= w; x += 24) {
            const y =
              baseY +
              Math.sin(x * (0.003 + layer * 0.0008) + t * (0.22 + layer * 0.08) + layer * 2) * (34 - layer * 5) +
              Math.cos(x * 0.007 - t * 0.15) * 14;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fillStyle = `rgba(55, 71, 79, ${(0.07 + layer * 0.065).toFixed(3)})`;
          ctx.fill();
        }
      } else if (mode === "live-sunset") {
        const bg = ctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, "#1c0d3d");
        bg.addColorStop(0.42, "#5b2166");
        bg.addColorStop(0.68, "#d9468f");
        bg.addColorStop(1, "#0f1024");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        // Glowing retro sun
        const sunY = h * 0.48 + Math.sin(t * 0.4) * 6;
        const sunG = ctx.createLinearGradient(0, sunY - 90, 0, sunY + 90);
        sunG.addColorStop(0, "#fde047");
        sunG.addColorStop(1, "#f43f5e");
        ctx.fillStyle = sunG;
        ctx.beginPath();
        ctx.arc(w * 0.5, sunY, Math.min(w, h) * 0.14, 0, Math.PI * 2);
        ctx.fill();
        // Moving perspective waves
        for (let layer = 0; layer < 5; layer++) {
          ctx.beginPath();
          const y0 = h * (0.62 + layer * 0.08);
          ctx.moveTo(0, h);
          for (let x = 0; x <= w; x += 26) {
            ctx.lineTo(x, y0 + Math.sin(x * 0.006 + t * (0.9 + layer * 0.25)) * (12 + layer * 3));
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fillStyle = `rgba(30, 14, 58, ${(0.28 + layer * 0.13).toFixed(2)})`;
          ctx.fill();
        }
      } else if (mode === "live-snow") {
        const bg = ctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, "#0b132b");
        bg.addColorStop(0.6, "#1c2541");
        bg.addColorStop(1, "#2a3b5c");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        for (const p of this.particles) {
          p.x = (p.x + Math.sin(t + p.phase) * 0.4 + w) % w;
          p.y = (p.y + 0.55 + p.r * 0.35) % h;
          ctx.fillStyle = `rgba(241, 245, 249, ${(0.35 + p.a * 0.5).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r + 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  window.OpenCodeLiveBg = LiveWallpaperEngine;
})();
