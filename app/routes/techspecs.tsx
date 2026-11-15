import { createRoute } from 'honox/factory'
import { TECH_SPECS_DOC_HTML } from '../lib/site-docs'

export default createRoute((c) =>
  c.render(
    <main class="policy-page">
      <article class="policy-document" dangerouslySetInnerHTML={{ __html: TECH_SPECS_DOC_HTML }} />
    </main>,
    { title: 'Tech Specs — manorama', description: 'The manorama engineering reference — architecture, the media model, the viewer contract, provider ingestion, and the native and desktop shells.' },
  ),
)
