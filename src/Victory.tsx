import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import './Victory.css';

interface VictoryProps {
  /** True while every due habit for today is completed. */
  active: boolean;
}

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: string;
  kind: 'confetti' | 'spark' | 'coin' | 'star';
  rot: number; spin: number;
  grav: number;
}

interface Burst {
  x: number; y: number;
  t: number;
  hue: number;
}

const COLORS = [
  '#4ade80', '#22c55e', '#facc15', '#fb923c', '#f472b6',
  '#60a5fa', '#a78bfa', '#2dd4bf', '#f87171', '#ffffff',
  '#fde68a', '#86efac',
];

const QUOTES: { text: string; by: string }[] = [
  { text: 'I came, I saw, I conquered.', by: 'Julius Caesar' },
  { text: 'The die is cast.', by: 'Julius Caesar' },
  { text: 'Come back with your shield — or on it.', by: 'Spartan mothers' },
  { text: 'Come and take them.', by: 'Leonidas of Sparta' },
  { text: 'I will either find a way, or make one.', by: 'Hannibal' },
  { text: 'Fortune favors the bold.', by: 'Virgil' },
  { text: 'If you want peace, prepare for war.', by: 'Vegetius' },
  { text: 'In the midst of chaos, there is also opportunity.', by: 'Sun Tzu' },
  { text: 'Know the enemy and know yourself; in a hundred battles, you will never be defeated.', by: 'Sun Tzu' },
  { text: 'He who is prudent and lies in wait for an enemy who is not, will be victorious.', by: 'Sun Tzu' },
  { text: 'Victory belongs to the most persevering.', by: 'Napoleon Bonaparte' },
  { text: 'Never interrupt your enemy when he is making a mistake.', by: 'Napoleon Bonaparte' },
  { text: 'I have not yet begun to fight!', by: 'John Paul Jones' },
  { text: 'Damn the torpedoes — full speed ahead!', by: 'David Farragut' },
  { text: 'Don’t fire until you see the whites of their eyes.', by: 'William Prescott' },
  { text: 'Nuts.', by: 'Anthony McAuliffe' },
  { text: 'We shall fight on the beaches… we shall never surrender.', by: 'Winston Churchill' },
  { text: 'I have nothing to offer but blood, toil, tears and sweat.', by: 'Winston Churchill' },
  { text: 'These are the times that try men’s souls.', by: 'Thomas Paine' },
  { text: 'The harder the conflict, the more glorious the triumph.', by: 'Thomas Paine' },
  { text: 'Give me liberty, or give me death!', by: 'Patrick Henry' },
  { text: 'Once more unto the breach, dear friends, once more.', by: 'William Shakespeare' },
  { text: 'We few, we happy few, we band of brothers.', by: 'William Shakespeare' },
  { text: 'Cry “Havoc!” and let slip the dogs of war.', by: 'William Shakespeare' },
  { text: 'Cowards die many times before their deaths; the valiant never taste of death but once.', by: 'William Shakespeare' },
  { text: 'War is cruelty. There is no use trying to reform it.', by: 'William Tecumseh Sherman' },
  { text: 'It is well that war is so terrible, or we should grow too fond of it.', by: 'Robert E. Lee' },
  { text: 'The art of war is of vital importance to the State.', by: 'Sun Tzu' },
  { text: 'A good general not only sees the way to victory; he knows when victory is impossible.', by: 'Polybius' },
  { text: 'Let them hate, so long as they fear.', by: 'Caligula' },
  { text: 'Death is lighter than a feather; duty, heavier than a mountain.', by: 'Yamamoto Tsunetomo' },
  { text: 'Even the finest sword plunged into salt water will eventually rust.', by: 'Sun Tzu' },
  { text: 'Who dares, wins.', by: 'British SAS' },
  { text: 'Through adversity, to the stars.', by: 'Royal Air Force' },
  { text: 'They shall not pass.', by: 'Robert Nivelle' },
  { text: 'I am the master of my fate: I am the captain of my soul.', by: 'William Ernest Henley' },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function VictoryCelebration({ active }: VictoryProps) {
  const [show, setShow] = useState(false);
  const [quote, setQuote] = useState(QUOTES[0]);
  const [burstKey, setBurstKey] = useState(0);
  const prev = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const particles = useRef<Particle[]>([]);
  const bursts = useRef<Burst[]>([]);
  const endAt = useRef(0);

  // Rising edge → launch the circus
  useEffect(() => {
    if (active && !prev.current) {
      setQuote(pick(QUOTES));
      setBurstKey(k => k + 1);
      setShow(true);
      endAt.current = performance.now() + 7800;
      // Seed an opening volley
      spawnVolley(0.55);
      spawnVolley(0.2);
      setTimeout(() => spawnVolley(0.75), 180);
      setTimeout(() => spawnVolley(0.4), 420);
      setTimeout(() => spawnFireworks(), 200);
      setTimeout(() => spawnFireworks(), 700);
      setTimeout(() => spawnFireworks(), 1400);
    }
    if (!active) {
      setShow(false);
      particles.current = [];
      bursts.current = [];
    }
    prev.current = active;
  }, [active]);

  function spawnVolley(xBias = 0.5) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = 0; i < 90; i++) {
      const kindRoll = Math.random();
      const kind: Particle['kind'] =
        kindRoll < 0.55 ? 'confetti' : kindRoll < 0.75 ? 'spark' : kindRoll < 0.9 ? 'coin' : 'star';
      particles.current.push({
        x: w * (xBias + (Math.random() - 0.5) * 0.35),
        y: h * (0.15 + Math.random() * 0.2),
        vx: (Math.random() - 0.5) * 14,
        vy: -Math.random() * 12 - 4,
        life: 1,
        maxLife: 0.7 + Math.random() * 1.4,
        size: kind === 'coin' ? 6 + Math.random() * 5 : 4 + Math.random() * 8,
        color: pick(COLORS),
        kind,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.4,
        grav: kind === 'spark' ? 0.08 : 0.22,
      });
    }
  }

  function spawnFireworks() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w * (0.2 + Math.random() * 0.6);
    const cy = h * (0.2 + Math.random() * 0.35);
    bursts.current.push({ x: cx, y: cy, t: 0, hue: Math.floor(Math.random() * 360) });
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2 + Math.random() * 0.2;
      const sp = 3 + Math.random() * 7;
      particles.current.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1,
        maxLife: 0.8 + Math.random() * 0.9,
        size: 2 + Math.random() * 4,
        color: `hsl(${Math.floor(Math.random() * 360)} 90% 60%)`,
        kind: 'spark',
        rot: 0, spin: 0,
        grav: 0.05,
      });
    }
  }

  // Canvas loop
  useEffect(() => {
    if (!show) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth * devicePixelRatio;
      canvas.height = window.innerHeight * devicePixelRatio;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      // Occasional late fireworks while celebration runs
      if (now < endAt.current && Math.random() < 0.02) spawnFireworks();
      if (now < endAt.current - 2000 && Math.random() < 0.015) spawnVolley(Math.random());

      // Burst rings
      bursts.current = bursts.current.filter(b => {
        b.t += dt;
        const r = b.t * 280;
        const alpha = Math.max(0, 1 - b.t / 0.9);
        if (alpha <= 0) return false;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${b.hue}, 90%, 60%, ${alpha * 0.7})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(b.x, b.y, r * 0.55, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${(b.hue + 40) % 360}, 90%, 70%, ${alpha * 0.4})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        return true;
      });

      particles.current = particles.current.filter(p => {
        p.life -= dt / p.maxLife;
        if (p.life <= 0) return false;
        p.vy += p.grav;
        p.vx *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.spin;
        const a = Math.max(0, Math.min(1, p.life));
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = a;
        if (p.kind === 'confetti') {
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else if (p.kind === 'coin') {
          ctx.fillStyle = '#facc15';
          ctx.strokeStyle = '#ca8a04';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size, p.size * (0.35 + Math.abs(Math.cos(p.rot)) * 0.65), 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (p.kind === 'star') {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          for (let i = 0; i < 5; i++) {
            const ang = (i * 4 * Math.PI) / 5 - Math.PI / 2;
            const r = i % 2 === 0 ? p.size : p.size * 0.45;
            const x = Math.cos(ang) * r;
            const y = Math.sin(ang) * r;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        return true;
      });

      if (now < endAt.current || particles.current.length || bursts.current.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setShow(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [show, burstKey]);

  // Auto-dismiss overlay chrome after the main blast (canvas may linger briefly)
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => {
      // Keep ambient complete styles via parent; hide loud overlay UI
      const el = document.querySelector('.victory-chrome');
      el?.classList.add('is-fading');
    }, 5200);
    return () => clearTimeout(t);
  }, [show, burstKey]);

  if (!show && !active) return null;

  return createPortal(
    <>
      {show && (
        <div className="victory-root" key={burstKey} aria-hidden>
          <canvas ref={canvasRef} className="victory-canvas" />
          <div className="victory-flash" />
          <div className="victory-rays" />
          <div className="victory-vignette" />
          <div className="victory-chrome">
            <div className="victory-ribbon victory-ribbon-l" />
            <div className="victory-ribbon victory-ribbon-r" />
            <div className="victory-banner">
              <span className="victory-banner-glow" />
              <span className="victory-banner-text">“{quote.text}”</span>
              <span className="victory-banner-sub">— {quote.by}</span>
            </div>
            <div className="victory-stickers">
              {([0, 1, 2, 3, 4, 5, 6, 7] as const).map(i => (
                <span key={i} style={{ '--i': i } as CSSProperties}>
                  {['✦', '★', '$', '◆', '✓', '✧', '●', '▲'][i]}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      {active && <div className="victory-ambient" aria-hidden />}
    </>,
    document.body,
  );
}
