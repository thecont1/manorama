import { createRoute } from 'honox/factory'

export default createRoute((c) => c.render(
  <main class="landing-page">
    <div class="landing-brand">
      <img src="/manorama-logo-upright-test.png" alt="" aria-hidden="true" class="landing-brand-mark" />
      <h1 class="landing-brand-title">manorama</h1>
      <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
    </div>
  </main>,
  { title: 'manorama' },
))
