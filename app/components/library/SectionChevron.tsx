/** The collapsible Library section's chevron — circled right/down marks,
 *  filled in currentColor so the rail's ink carries them. The host
 *  button supplies the accessible name; the glyph is decorative. */
export const SectionChevron = ({ open }: { open: boolean }) => (
  <span class="lib-hidden-chevron" aria-hidden="true">
    {open ? (
      <svg viewBox="0 0 1792 1792" width="30" height="30"><path d="M941 1299l454-454q19-19 19-45t-19-45l-102-102q-19-19-45-19t-45 19L896 960 589 653q-19-19-45-19t-45 19L397 755q-19 19-45 45t19 45l454 454q19 19 45 19t45-19zm723-403q0 209-103 385.5T1281.5 1561 896 1664t-385.5-103T231 1281.5 128 896t103-385.5T510.5 231 896 128t385.5 103T1561 510.5 1664 896z" fill="currentColor" /></svg>
    ) : (
      <svg viewBox="0 0 1792 1792" width="30" height="30"><path d="M845 1395l454-454q19-19 19-45t-19-45L845 397q-19-19-45-19t-45 19L653 499q-19 19-19 45t19 45l307 307-307 307q-19 19-19 45t19 45l102 102q19 19 45 19t45-19zm819-499q0 209-103 385.5T1281.5 1561 896 1664t-385.5-103T231 1281.5 128 896t103-385.5T510.5 231 896 128t385.5 103T1561 510.5 1664 896z" fill="currentColor" /></svg>
    )}
  </span>
)
