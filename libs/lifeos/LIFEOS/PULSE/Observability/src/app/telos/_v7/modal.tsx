"use client";

import { useEffect } from "react";
import type { Goal, Telos } from "./data";
import { Icons } from "./icons";
import { Spark } from "./subtabs";

// Goal drill-down modal — warmer, sentence-led.

interface GoalModalProps {
  telos: Telos;
  goal: Goal | null;
  onClose: () => void;
  showIds: boolean;
}

export function GoalModal({ telos, goal, onClose, showIds }: GoalModalProps) {
  useEffect(()=>{
    if (!goal) return;
    const esc = (e: KeyboardEvent)=>e.key==='Escape' && onClose();
    window.addEventListener('keydown', esc);
    return ()=>window.removeEventListener('keydown', esc);
  },[goal, onClose]);

  if (!goal) return null;
  const linkedC = telos.challenges.filter(c=>c.blocks.includes(goal.id));
  const linkedS = telos.strategies.filter(s=>s.implements.includes(goal.id));
  const linkedP = telos.projects.filter(p=>linkedS.some(s=>s.id===p.strategy));
  const dim = telos.dimensions.find(d=>d.id===goal.dims[0]);
  const seed = [goal.pct-18,goal.pct-14,goal.pct-11,goal.pct-9,goal.pct-6,goal.pct-4,goal.pct-1,goal.pct,goal.pct+0,goal.pct+1,goal.pct+2].map(v=>Math.max(0,Math.min(100,v)));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <div className="modal-eyebrow">
              a goal in <span style={{color:`var(${dim?.color ?? '--accent'})`}}>{goal.dims.join(' & ')}</span>
              {showIds && <span className="mono" style={{marginLeft:10,color:'var(--text-4)'}}>{goal.id}</span>}
            </div>
            <h2 className="modal-title">{goal.title}</h2>
          </div>
          <button className="modal-x" onClick={onClose}><Icons.X size={16}/></button>
        </header>

        <div className="modal-kpis">
          <div className="mk"><div className="mk-l">where it is</div><div className="mk-v mono">{goal.kpi}</div></div>
          <div className="mk"><div className="mk-l">aiming for</div><div className="mk-v mono">{goal.target}</div></div>
          <div className="mk"><div className="mk-l">progress</div><div className="mk-v mono">{goal.pct}%</div></div>
          <div className="mk"><div className="mk-l">last month</div><div className="mk-v mono" style={{color:goal.delta>0?'var(--ok)':goal.delta<0?'var(--bad)':'var(--text-3)'}}>{goal.delta>0?'+':''}{goal.delta}</div></div>
          <div className="mk mk-wide">
            <div className="mk-l">last eleven weeks</div>
            <Spark points={seed} color={`var(${dim?.color ?? '--accent'})`}/>
          </div>
        </div>

        <div className="modal-grid">
          <div className="modal-col">
            <div className="modal-col-head">What&rsquo;s in the way</div>
            {linkedC.length===0 && <div className="empty">Nothing visible. Clean runway for now.</div>}
            {linkedC.map(c=>(
              <div key={c.id} className="modal-line">
                {showIds && <span className="mono id" style={{color:'var(--warm)'}}>{c.id}</span>}
                <div><div className="ml-title">{c.title}</div><div className="ml-note">{c.note}</div></div>
              </div>
            ))}
          </div>
          <div className="modal-col">
            <div className="modal-col-head">How we&rsquo;re answering</div>
            {linkedS.length===0 && <div className="empty">No plan attached yet. This one&rsquo;s still loose.</div>}
            {linkedS.map(s=>(
              <div key={s.id} className="modal-line">
                {showIds && <span className="mono id" style={{color:'var(--accent-2)'}}>{s.id}</span>}
                <div><div className="ml-title">{s.title.split('—')[0].trim()}</div><div className="ml-note">{s.title.split('—')[1]?.trim()}</div></div>
              </div>
            ))}
          </div>
          <div className="modal-col">
            <div className="modal-col-head">What&rsquo;s actually happening</div>
            {linkedP.length===0 && <div className="empty">Nothing in motion right now.</div>}
            {linkedP.map(p=>(
              <div key={p.id} className="modal-line">
                <span className={'dot '+(p.status==='green'?'dot-ok':p.status==='amber'?'dot-warn':'dot-bad')} style={{marginTop:7}}/>
                <div><div className="ml-title">{p.title}</div><div className="ml-note">{p.work.length} thing{p.work.length===1?'':'s'} in flight</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
