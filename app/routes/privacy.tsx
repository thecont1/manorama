import { createRoute } from 'honox/factory'
import PrivacyPolicy from '../components/PrivacyPolicy'

export default createRoute((c) =>
  c.render(
    <main class="policy-page">
      <PrivacyPolicy />
    </main>,
    { title: 'Privacy Policy — manorama', description: 'What Manorama keeps about gallery viewers, owners, and paid plans — on the web at manorama.xyz and in the mobile and desktop apps.' },
  ),
)
