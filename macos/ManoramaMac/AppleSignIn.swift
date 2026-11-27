import AppKit
import AuthenticationServices
import Foundation

/// Native Sign in with Apple for the macOS shell.
///
/// ASAuthorizationController is the one truly in-app authentication
/// surface macOS offers: the system sheet, the user's own Apple ID,
/// no web flow at all. The controller's identity token is verified
/// server-side at /api/auth/native/apple, so the shell never has to
/// trust what the credential claims — it only relays it.
///
/// The class stays nonisolated like ViewerCoordinator: the delegate and
/// presentation-context callbacks arrive on the main thread, and the
/// completion is typed @MainActor so the bridge hears it synchronously.
final class AppleSignInController: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    struct Credential {
        let identityToken: String
        let fullName: String?
        let email: String?
    }

    enum Outcome {
        case success(Credential)
        /// The user dismissed the system sheet — a no-op, never a fallback.
        case cancelled
        /// The flow could not run or complete — the caller falls back to
        /// the in-app web sheet.
        case failed
    }

    private let anchor: NSWindow
    private let nonce: String
    private var completion: (@MainActor (Outcome) -> Void)?
    private var controller: ASAuthorizationController?

    init(anchor: NSWindow, nonce: String, completion: @escaping @MainActor (Outcome) -> Void) {
        self.anchor = anchor
        self.nonce = nonce
        self.completion = completion
        super.init()
    }

    func start() {
        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        controller.performRequests()
        Trace.log("native apple sign-in requested")
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            finish(.failed)
            return
        }
        // Name and email arrive only on the first consent — the server
        // treats them as gaps to fill, never as authoritative identity.
        var fullName: String?
        if let components = credential.fullName {
            let name = PersonNameComponentsFormatter().string(from: components)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { fullName = name }
        }
        finish(.success(Credential(identityToken: identityToken, fullName: fullName, email: credential.email)))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let code = (error as? ASAuthorizationError)?.code
        Trace.log("native apple sign-in error code=\(code?.rawValue ?? -1) \(error.localizedDescription)")
        if code == .canceled {
            finish(.cancelled)
        } else {
            finish(.failed)
        }
    }

    /// Report exactly once — the controller is single-use, and a second
    /// callback after completion must not reach the bridge.
    private func finish(_ outcome: Outcome) {
        let completion = self.completion
        self.completion = nil
        controller = nil
        if let completion {
            MainActor.assumeIsolated { completion(outcome) }
        }
    }
}
