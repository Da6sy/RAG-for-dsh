/** ClueHarness network mark: an open C-shaped route connects evidence nodes. */
export interface ClueBrandMarkProps {
  size: number
  className?: string
}

/** Render a self-contained SVG without shared gradient IDs. */
export function ClueBrandMark({ size, className }: ClueBrandMarkProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="2" y="2" width="44" height="44" rx="14" fill="#102D2B" />
    <path d="M34 13L22 10L12 19L14 32L27 38L37 29M12 19L25 24L34 13M14 32L25 24L37 29M25 24L27 38" stroke="#5DD4BA" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="22" cy="10" r="2.5" fill="#D6F5EA" /><circle cx="12" cy="19" r="3" fill="#D6F5EA" />
    <circle cx="14" cy="32" r="2.5" fill="#5DD4BA" /><circle cx="27" cy="38" r="2.5" fill="#5DD4BA" />
    <circle cx="37" cy="29" r="3" fill="#D6F5EA" /><circle cx="34" cy="13" r="3" fill="#E7B566" />
    <circle cx="25" cy="24" r="6" fill="#102D2B" /><circle cx="25" cy="24" r="3.5" fill="#E7B566" />
  </svg>
}

/** Text wordmark remains accessible at small sidebar sizes. */
export function ClueBrandName() {
  return <span className="clue-brand-name">Clue<span className="clue-brand-accent">Harness</span></span>
}
