import SwiftUI

/// The shell's one native setting.
///
/// The Library and the Viewer own every display and gallery preference —
/// this pane holds only the launch behaviour that is the shell's to own:
/// whether a launch opens the window into its own fullscreen Space. The
/// value lands in UserDefaults under `AppModel.launchFullScreenDefaultsKey`,
/// which `applyLaunchWindowMode` reads once per launch; toggling it changes
/// the next launch, never the current window.
struct SettingsView: View {
    @AppStorage(AppModel.launchFullScreenDefaultsKey) private var openInFullScreen = false

    var body: some View {
        Form {
            Toggle("Open in full screen", isOn: $openInFullScreen)
        }
        .padding(20)
        .frame(width: 300)
    }
}
