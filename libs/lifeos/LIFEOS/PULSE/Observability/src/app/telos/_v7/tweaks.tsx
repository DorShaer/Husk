"use client";

import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";

// Tweaks panel — density, narrative tone, why-view default, palette.

export interface TweakVals {
  density: "compact" | "comfortable" | "spacious";
  narrativeTone: "operator" | "terse";
  paletteMode: "tokyo-night" | "tokyo-mono" | "cb-safe";
  accentHue: number;
}

type TweakKey = keyof TweakVals;

interface TweakOption<K extends TweakKey> {
  v: TweakVals[K];
  l: string;
}

interface SegProps<K extends TweakKey> {
  k: K;
  options: readonly TweakOption<K>[];
}

export interface TweakState {
  vals: TweakVals;
  set: <K extends TweakKey>(k: K, v: TweakVals[K]) => void;
  visible: boolean;
}

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "comfortable",
  "narrativeTone": "operator",
  "paletteMode": "tokyo-night",
  "accentHue": 265
}/*EDITMODE-END*/ satisfies TweakVals;

export function useTweaks(): TweakState {
  const [vals, setVals] = useState<TweakVals>(TWEAK_DEFAULTS);
  const [visible, setVisible] = useState(false);
  useEffect(()=>{
    const h = (e: MessageEvent)=>{
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === '__activate_edit_mode')   setVisible(true);
      if (e.data.type === '__deactivate_edit_mode') setVisible(false);
    };
    if (typeof window === "undefined") return;
    window.addEventListener('message', h);
    window.parent.postMessage({type:'__edit_mode_available'}, '*');
    return ()=>window.removeEventListener('message', h);
  },[]);
  const set = <K extends TweakKey>(k: K, v: TweakVals[K])=>{
    setVals(prev=>({...prev,[k]:v}));
    if (typeof window === "undefined") return;
    window.parent.postMessage({type:'__edit_mode_set_keys', edits:{[k]:v}}, '*');
  };
  useEffect(()=>{
    if (typeof document === "undefined") return;
    document.documentElement.dataset.density = vals.density;
    document.documentElement.dataset.palette = vals.paletteMode;
    document.documentElement.style.setProperty('--accent', `oklch(72% 0.17 ${vals.accentHue})`);
    document.documentElement.style.setProperty('--accent-2', `oklch(80% 0.13 ${vals.accentHue})`);
  },[vals]);
  return { vals, set, visible };
}

export function TweakPanel({ vals, set, visible }: TweakState) {
  if (!visible) return null;
  const Seg = <K extends TweakKey>({k, options}: SegProps<K>)=> (
    <div className="tw-seg mono">
      {options.map(o=>(
        <button key={o.v} className={vals[k]===o.v?'on':''} onClick={()=>set(k,o.v)}>{o.l}</button>
      ))}
    </div>
  );
  return (
    <div className="tweaks">
      <header className="tw-head mono">
        <span className="led"/>TWEAKS
        <span className="tw-meta">persisted to file</span>
      </header>
      <div className="tw-row">
        <div className="tw-label mono">DENSITY</div>
        <Seg k="density" options={[{v:'compact',l:'compact'},{v:'comfortable',l:'comfy'},{v:'spacious',l:'spacious'}]}/>
      </div>
      <div className="tw-row">
        <div className="tw-label mono">NARRATIVE TONE</div>
        <Seg k="narrativeTone" options={[{v:'operator',l:'operator'},{v:'terse',l:'terse'}]}/>
      </div>
      <div className="tw-row">
        <div className="tw-label mono">PALETTE</div>
        <Seg k="paletteMode" options={[{v:'tokyo-night',l:'tokyo-night'},{v:'tokyo-mono',l:'mono'},{v:'cb-safe',l:'cb-safe'}]}/>
      </div>
      <div className="tw-row">
        <div className="tw-label mono">ACCENT HUE <span className="tw-hue mono">{vals.accentHue}°</span></div>
        <input type="range" min="0" max="360" step="5" value={vals.accentHue}
               onChange={(e: ChangeEvent<HTMLInputElement>)=>set('accentHue', +e.target.value)} className="tw-slider"/>
      </div>
    </div>
  );
}
