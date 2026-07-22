"use client";

import type { ReactNode } from "react";
import type { Telos } from "./data";
import type { TweakVals } from "./tweaks";
import { DimensionBars } from "./dimension-bars";
import { summarizeTelos } from "./summary";
import { StillnessKit } from "./stillness-kit";

// Hero — narrative + 6 Current-Ideal gap rings.

interface TraceTextProps {
  id: string | null | undefined;
  children: ReactNode;
  cls?: string;
  showIds: boolean;
  onTrace: (id: string | null) => void;
}

interface NarrativeProps {
  telos: Telos;
  tone?: TweakVals["narrativeTone"];
  showIds: boolean;
  onTrace: (id: string | null) => void;
}

interface HeroProps {
  telos: Telos;
  tone: TweakVals["narrativeTone"];
  showIds: boolean;
  onTrace: (id: string | null) => void;
  openFile?: (name: string) => void;
  isPersonalized?: boolean;
}

type MoodDimension = Telos["dimensions"][number];

interface MoodDimensions {
  positive: MoodDimension;
  flat: MoodDimension;
  negative: MoodDimension;
}

function TraceText({ id, children, cls, showIds, onTrace }: TraceTextProps) {
  return (
    <span className={'n-trace '+(cls||'')} role="button" tabIndex={0} onClick={()=>onTrace(id ?? null)}>
      {children}{showIds && id && <span className="n-id mono">{id}</span>}
    </span>
  );
}

function pickMoodDimensions(dimensions: readonly MoodDimension[]): MoodDimensions | null {
  if (dimensions.length < 3) {
    // Fewer than three dimensions cannot support a climbing/steady/drifting trio.
    return null;
  }
  let positive: MoodDimension | null = null;
  let flat: MoodDimension | null = null;
  let negative: MoodDimension | null = null;
  for (const dimension of dimensions) {
    if (dimension.velo > 0 && (!positive || dimension.velo > positive.velo)) {
      positive = dimension;
    }
    if (!flat || Math.abs(dimension.velo) < Math.abs(flat.velo)) {
      flat = dimension;
    }
    if (dimension.velo < 0 && (!negative || dimension.velo < negative.velo)) {
      negative = dimension;
    }
  }
  if (!positive || !negative || !flat) {
    // If all velocities share one sign, omit the mood line instead of inventing contrast.
    return null;
  }
  return { positive, flat, negative };
}

function buildMoodLine(dimensions: readonly MoodDimension[]): string | null {
  const moodDimensions = pickMoodDimensions(dimensions);
  return moodDimensions
    ? `${moodDimensions.positive.label.toLowerCase()} climbing. ${moodDimensions.flat.label.toLowerCase()} steady. ${moodDimensions.negative.label.toLowerCase()} drifting.`
    : null;
}

function Narrative({ telos, tone='operator', showIds, onTrace }: NarrativeProps) {
  const n = telos.narrativeSeed;
  // Personalized installs return narrativeSeed: null until a current-work
  // pointer is wired to live work-system state. The EMPTY skeleton substitutes
  // a blank narrativeSeed (push_name === ''); skip the paragraph in either
  // case rather than render a fixture-flavored sentence.
  if (!n || !n.push_name) return null;
  const work = telos.projects.flatMap(p=>p.work).find(w=>w.id===n.current_work);
  const strat = telos.strategies.find(s=>s.id===n.via_strategy);
  const chal  = telos.challenges.find(c=>c.id===n.addresses);
  const goal  = telos.goals.find(g=>g.id===n.moves_goal);
  const miss  = telos.missions.find(m=>m.id===n.serves_mission);
  const prob  = telos.problems.find(p=>(miss?.addresses||[]).includes(p.id));

  if (!work || !strat || !chal || !goal || !miss) return null;

  const strategyTitle = strat.title.toLowerCase();
  const challengeTitle = chal.title.toLowerCase();
  const goalTitle = goal.title.toLowerCase();
  const missionTitle = miss.title.toLowerCase();
  const problemTitle = prob?.title.toLowerCase();
  const moodLine = buildMoodLine(telos.dimensions);

  const Trace = ({ id, children, cls }: Omit<TraceTextProps, "showIds" | "onTrace">) => (
    <TraceText id={id} cls={cls} showIds={showIds} onTrace={onTrace}>{children}</TraceText>
  );

  if (tone === 'terse') {
    return (
      <p className="narrative">
        <Trace id={null} cls="n-accent">{n.days_into}</Trace> {n.push_name}.{' '}
        <Trace id={work.id} cls="n-accent">{work.title.toLowerCase()}</Trace> —{' '}
        <Trace id={strat.id} cls="n-soft">{strategyTitle}</Trace>,{' '}
        <Trace id={chal.id} cls="n-warm">{challengeTitle}</Trace>.
      </p>
    );
  }

  return (
    <p className="narrative">
      You&rsquo;re <span className="n-accent">{n.days_into} days</span> into the <span className="n-accent">{n.push_name}</span>.
      {' '}Right now you&rsquo;re on <Trace id={work.id} cls="n-accent">{work.title.toLowerCase()}</Trace> —
      a <Trace id={strat.id} cls="n-soft">{strategyTitle}</Trace> move,
      pressing on <Trace id={chal.id} cls="n-warm">{challengeTitle}</Trace>.
      {' '}It pushes <Trace id={goal.id} cls="n-soft">{goalTitle}</Trace> forward,
      serves <Trace id={miss.id} cls="n-warm">{missionTitle}</Trace>
      {problemTitle && (
        <>
          , and pulls at <Trace id={prob?.id} cls="n-warm">{problemTitle}</Trace>
        </>
      )}.
      {moodLine && <> {' '}<span className="n-quiet">{moodLine}</span></>}
    </p>
  );
}

export function Hero({ telos, tone, showIds, onTrace, openFile, isPersonalized }: HeroProps) {
  const { projects, dimensions, snapshot, owner, idealState } = telos;
  const hasOwner = !!owner.day;            // EMPTY skeleton has owner.day === ''
  const hasIdealState = !!idealState.note; // EMPTY skeleton has idealState.note === ''
  const green = projects.filter(p=>p.status==='green').length;
  const amber = projects.filter(p=>p.status==='amber').length;
  const red   = projects.filter(p=>p.status==='red').length;
  const wip   = projects.reduce((a,p)=>a+p.work.length,0);

  // Universal summary — operates only on telos schema, no hardcoded names.
  // Returns null on fixture installs and structurally-empty TELOS, so the
  // Hero falls back to its existing rings-first layout for those cases.
  const summary = summarizeTelos(telos, isPersonalized === true);

  const hasNarratives = !!(telos.currentStateNarrative && telos.idealStateNarrative);

  return (
    <section className="hero" id="sec-current">
      {hasOwner && (
        <div className="hero-date">
          <span className="hero-date-day">{owner.day}</span>
          <span className="hero-streak">
            <span className="hero-streak-flame">◆</span>
            <span>{owner.streak} days in a row</span>
          </span>
          <span className="hero-date-meta">· 09:14</span>
        </div>
      )}

      {(telos.synthesisSegments || telos.synthesisParagraph || telos.recommendedNextAction || telos.currentStateBullets || telos.idealStateBullets || hasNarratives) && (
        <div className="hero-state-block">
          {telos.synthesisSegments && telos.synthesisSegments.length > 0 ? (
            <p className="hero-synthesis">
              {telos.synthesisSegments.map((seg, i) => {
                if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
                const cls = `synth-tok synth-tok-${seg.kind}`;
                if (seg.id) {
                  return (
                    <button
                      key={i}
                      type="button"
                      className={cls}
                      onClick={() => onTrace(seg.id!)}
                      title={`${seg.kind.toUpperCase()} — ${seg.id}`}
                    >
                      {seg.text}
                    </button>
                  );
                }
                return <span key={i} className={cls}>{seg.text}</span>;
              })}
            </p>
          ) : telos.synthesisParagraph ? (
            <p className="hero-synthesis">{telos.synthesisParagraph}</p>
          ) : null}
          {telos.recommendedNextAction && (
            <p className="hero-next-action">
              <span className="hero-next-tag">Next</span>
              <span>{telos.recommendedNextAction}</span>
            </p>
          )}
          {(telos.currentStateBullets || telos.idealStateBullets || hasNarratives) && (
            <div className="hero-state-cards">
              <div className="hero-state-card hero-state-card-current">
                <div className="hero-state-card-label">Current State</div>
                {telos.currentStateBullets && telos.currentStateBullets.length > 0 ? (
                  <ul className="hero-state-card-list">
                    {telos.currentStateBullets.map((b) => (
                      <li key={b.label}>
                        <span className="hero-state-card-key">{b.label}</span>
                        <span className="hero-state-card-val">{b.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : telos.currentStateNarrative ? (
                  <p className="hero-state-card-body">{telos.currentStateNarrative}</p>
                ) : null}
              </div>
              <div className="hero-state-card hero-state-card-ideal" id="sec-ideal">
                <div className="hero-state-card-label">Ideal State</div>
                {telos.idealStateBullets && telos.idealStateBullets.length > 0 ? (
                  <ul className="hero-state-card-list">
                    {telos.idealStateBullets.map((b) => (
                      <li key={b.label}>
                        <span className="hero-state-card-key">{b.label}</span>
                        <span className="hero-state-card-val">{b.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : telos.idealStateNarrative ? (
                  <p className="hero-state-card-body">{telos.idealStateNarrative}</p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="hero-top-row">
        {summary ? (
          <div className="hero-summary">
            <p className="hero-summary-headline">{summary.headline}</p>
            {summary.position && (
              <p className="hero-summary-line"><span className="hero-summary-tag">Position</span>{summary.position}</p>
            )}
            {summary.traction && (
              <p className="hero-summary-line"><span className="hero-summary-tag hero-summary-tag-ok">Traction</span>{summary.traction}</p>
            )}
            {summary.pinch && (
              <p className="hero-summary-line"><span className="hero-summary-tag hero-summary-tag-warn">Pinch</span>{summary.pinch}</p>
            )}
            {summary.drift && (
              <p className="hero-summary-line"><span className="hero-summary-tag hero-summary-tag-warn">Drift</span>{summary.drift}</p>
            )}
            {summary.recommendations && (
              <p className="hero-summary-line hero-summary-line-recs"><span className="hero-summary-tag hero-summary-tag-next">Next</span>{summary.recommendations}</p>
            )}
          </div>
        ) : <div />}
        <StillnessKit telos={telos} />
      </div>

      {hasIdealState && (
        <div className="ideal-head">
          <div className="ideal-head-l">
            <span className="ideal-label">Current vs Ideal</span>
            <span className="ideal-horizon">{idealState.horizon}</span>
          </div>
          <span className="ideal-note">{idealState.note}</span>
        </div>
      )}

      <DimensionBars
        dimensions={dimensions}
        onDimClick={(id) => (openFile ? openFile("TELOS.md") : onTrace(id))}
      />

      {telos.workNarrative && (
        <p className="hero-work-narrative" style={{padding:'12px 24px 0',color:'var(--text-2)',fontSize:'14px',lineHeight:1.5}}>
          {telos.workNarrative.summary}
        </p>
      )}

      <Narrative telos={telos} tone={tone} showIds={showIds} onTrace={onTrace}/>

      {projects.length > 0 && (
        <p className="hero-sub">
          {green} moving well. {amber} need{amber===1?'s':''} attention.
          {red > 0 && <> {red===1?'One is':`${red} are`} stuck.</>}
          {' '}<span className="hero-sub-soft">{wip} threads in flight · cap is 2.</span>
        </p>
      )}

      <div className="hero-snapshot">
        {snapshot.map(s=>{
          const label =
            s.id==='mood'   ? (s.v>=7?'steady':s.v>=5?'mixed':'low') :
            s.id==='energy' ? `${s.v.toFixed(0)} / 10` :
                              (s.v>=8?'sharp':s.v>=6?'clear':'scattered');
          return (
            <div key={s.id} className="snap">
              <span className="snap-dot" style={{background:`var(${s.id==='mood'?'--freedom':s.id==='energy'?'--money':'--creative'})`,opacity:0.35 + (s.v/s.of)*0.65}}/>
              <span className="snap-label">{s.label}</span>
              <span className="snap-sep">·</span>
              <span className="snap-value">{label}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
