import { createRoute } from 'honox/factory'
import { ABOUT_DOC_HTML } from '../lib/site-docs'

export default createRoute((c) =>
  c.render(
    <main class="policy-page">
      <article class="policy-document" dangerouslySetInnerHTML={{ __html: ABOUT_DOC_HTML }} />
    </main>,
    { title: 'About — manorama', description: 'What manorama is — photography-first gallery publishing for the web, iOS, macOS, Windows, Linux and Android.' },
  ),
)
