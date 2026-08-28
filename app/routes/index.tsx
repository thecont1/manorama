import { createRoute } from 'honox/factory'

export default createRoute((c) => c.render(
  <main class="landing-page">
    <div class="landing-brand">
      <img src="/manorama-logo-upright.svg" alt="" aria-hidden="true" class="landing-brand-mark" />
      <h1 class="landing-brand-title">manorama.xyz</h1>
      <p class="landing-brand-intro">adj. a view that is delightful to the mind.<br />Also, simply the wow-est way to share photos with anyone!</p>
    </div>
  </main>,
  { title: 'manorama.xyz' },
))
