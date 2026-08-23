import { studioMarkForSurface, type StudioMarkSurface } from '../brand';

interface StudioMarkProps {
  surface?: StudioMarkSurface;
  className?: string;
  decorative?: boolean;
}

export function StudioMark({
  surface = 'dark',
  className = 'studio-symbol',
  decorative = true,
}: StudioMarkProps) {
  return <img
    className={className}
    src={studioMarkForSurface(surface)}
    alt={decorative ? '' : 'Sthang Studio'}
    aria-hidden={decorative || undefined}
    draggable={false}
  />;
}

interface StudioBrandProps {
  variant?: 'hero' | 'compact';
  moduleLabel?: string;
  moduleDescriptor?: string;
  markSurface?: StudioMarkSurface;
}

export function StudioBrand({
  variant = 'hero',
  moduleLabel = 'CAPTIONS',
  moduleDescriptor = 'Khmer-first workspace',
  markSurface = 'dark',
}: StudioBrandProps) {
  return <div className={`studio-brand studio-brand-${variant}`}>
    <div className="studio-symbol-wrap" aria-hidden="true">
      <StudioMark surface={markSurface}/>
    </div>
    <div className="studio-brand-copy">
      <div className="studio-family-lockup">
        <img className="sthang-wordmark" src="/brand/sthang-wordmark.png" alt="Sthang" draggable={false}/>
        <span className="studio-lockup-divider" aria-hidden="true"/>
        <span className="studio-product-name">STUDIO</span>
      </div>
      <div className="studio-module-row">
        <span>{moduleLabel}</span>
        {moduleDescriptor && <><i aria-hidden="true"/><em>{moduleDescriptor}</em></>}
      </div>
    </div>
  </div>;
}
