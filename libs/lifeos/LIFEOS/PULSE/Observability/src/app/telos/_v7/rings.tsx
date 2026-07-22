"use client";

import type { ReactNode } from "react";
import type { Dimension, SnapshotMetric } from "./data";

// Arc rings. Larger, softer, human labels underneath.

interface RingProps {
  pct: number;
  ideal?: number;
  color?: string;
  size?: number;
  stroke?: number;
  children: ReactNode;
  track?: string;
}

interface DimensionRingProps {
  d: Dimension;
  onClick?: () => void;
}

interface MicroRingProps {
  s: SnapshotMetric;
}

export function Ring({ pct, ideal=100, color='--accent', size=96, stroke=6, children, track='--bg-3' }: RingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cur = Math.max(0, Math.min(100, pct));
  const idl = Math.max(0, Math.min(100, ideal));
  const dashCur = (cur / 100) * c;
  const dashIdl = (idl / 100) * c;
  return (
    <div className="ring-wrap" style={{ width:'100%', aspectRatio:'1 / 1', maxWidth:size, position:'relative', margin:'0 auto' }}>
      <svg viewBox={`0 0 ${size} ${size}`} preserveAspectRatio="xMidYMid meet" style={{width:'100%', height:'100%', transform:'rotate(-90deg)', display:'block'}}>
        <circle cx={size/2} cy={size/2} r={r} stroke={`var(${track})`} strokeWidth={stroke} fill="none" strokeOpacity={0.55}/>
        <circle cx={size/2} cy={size/2} r={r}
          stroke={`var(${color})`} strokeOpacity={0.18}
          strokeWidth={stroke} fill="none"
          strokeDasharray={`${dashIdl} ${c}`} strokeLinecap="butt"/>
        <circle cx={size/2} cy={size/2} r={r}
          stroke={`var(${color})`}
          strokeWidth={stroke} fill="none"
          strokeDasharray={`${dashCur} ${c}`} strokeLinecap="round"
          style={{transition:'stroke-dasharray 600ms cubic-bezier(0.4,0,0.2,1)'}}/>
      </svg>
      <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',lineHeight:1}}>
        {children}
      </div>
    </div>
  );
}

export function DimensionRing({ d, onClick }: DimensionRingProps) {
  const up = d.velo > 0.15, dn = d.velo < -0.15;
  const delta = Math.round(d.velo);
  const cadence =
    Math.abs(d.velo) < 0.2 ? 'holding steady' :
    up   ? `+${delta || 1} this month` :
           `${delta || -1} this month`;

  return (
    <div className="dim" onClick={onClick}>
      <Ring pct={d.cur} ideal={d.ideal} color={d.color} size={120} stroke={6}>
        <div className="mono dim-num">{d.cur}</div>
      </Ring>
      <div className="dim-label">
        <div className="dim-name">{d.label}</div>
        <div className={'dim-velo '+(up?'up':dn?'down':'flat')}>
          {up ? '↗' : dn ? '↘' : '·'} {cadence}
        </div>
      </div>
    </div>
  );
}

export function MicroRing({ s }: MicroRingProps) {
  const pct = (s.v / s.of) * 100;
  const color = s.id==='mood' ? '--freedom' : s.id==='energy' ? '--money' : '--creative';
  return (
    <div className="micro">
      <Ring pct={pct} color={color} size={44} stroke={4} track="--bg-3">
        <div className="mono" style={{fontSize:11,fontWeight:600}}>{s.v.toFixed(1)}</div>
      </Ring>
      <div className="micro-label">{s.label}</div>
    </div>
  );
}
