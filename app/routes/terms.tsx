import { createRoute } from 'honox/factory'
import { TERMS_DOC_HTML } from '../lib/site-docs'

export default createRoute((c) =>
  c.render(
    <main class="policy-page">
      <article class="policy-document" dangerouslySetInnerHTML={{ __html: TERMS_DOC_HTML }} />
    </main>,
    { title: 'Terms — manorama', description: 'The terms that govern use of manorama — accounts, subscriptions and billing, content, acceptable use, and liability.' },
  ),
)
