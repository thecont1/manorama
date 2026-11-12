import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('native platform adaptations', () => {
  test('Android resizes the WebView around the keyboard', () => {
    const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"')
  })

  test('Android keeps the vault out of cloud backup, as the privacy policy promises', () => {
    // The vault root travels in both rule files — and it is read back out of
    // vault.ts so a rename cannot silently re-enable the backup. Checks are
    // structural: the exclude has to live inside each backup section, and
    // the manifest references on the application element itself.
    const vaultSource = readFileSync(new URL('./lib/vault.ts', import.meta.url), 'utf8')
    const vaultRoot = vaultSource.match(/VAULT_ROOT = '([^']+)'/)?.[1]
    expect(vaultRoot).toBeTruthy()
    const section = (xml: string, tag: string) =>
      xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? ''
    const exclude = `<exclude domain="file" path="${vaultRoot}"`
    const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
    const application = manifest.match(/<application[\s\S]*?>/)?.[0] ?? ''
    expect(application).toContain('android:fullBackupContent="@xml/backup_rules"')
    expect(application).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
    const legacy = readFileSync(new URL('../android/app/src/main/res/xml/backup_rules.xml', import.meta.url), 'utf8')
    expect(section(legacy, 'full-backup-content')).toContain(exclude)
    const extraction = readFileSync(new URL('../android/app/src/main/res/xml/data_extraction_rules.xml', import.meta.url), 'utf8')
    expect(section(extraction, 'cloud-backup')).toContain(exclude)
    expect(section(extraction, 'device-transfer')).toContain(exclude)
  })

  test('the Library and editor have explicit Light grounds', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    for (const selector of ['.native-list-shell', '.native-editor']) {
      expect(css).toContain(`html.light body.manorama-native ${selector}`)
    }
  })

  test('Android system bars keep a dark canvas with light glyphs', () => {
    const styles = readFileSync(new URL('../android/app/src/main/res/values/styles.xml', import.meta.url), 'utf8')
    for (const item of ['android:statusBarColor', 'android:navigationBarColor']) {
      expect(styles).toContain(`${item}">@color/colorPrimaryDark`)
    }
    expect(styles).toContain('android:windowLightStatusBar">false')
    expect(styles).toContain('android:windowLightNavigationBar">false')
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
    expect(main).toContain("StatusBar.setBackgroundColor({ color: theme === 'light' ? '#f3f0e8' : '#0a0a0a' })")
  })

  test('the Welcome logo anchors its domain suffix to the mark, not the viewport', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    const rule = css.match(/\.native-welcome-logo \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('position: relative')
    expect(rule).toContain('display: inline-flex')
    expect(rule).toContain('justify-self: start')
  })

  test('status-bar content follows the owner theme', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
    // Capacitor names the background: Dark = light glyphs; Light = dark glyphs.
    expect(main).toContain("theme === 'light' ? Style.Light : Style.Dark")
    expect(main).toContain('void configureNativeChrome(ownerTheme)')
  })
})
