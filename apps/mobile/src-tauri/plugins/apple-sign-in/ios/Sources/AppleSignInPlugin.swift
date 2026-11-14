import AuthenticationServices
import Tauri
import UIKit
import WebKit

class SignInArgs: Decodable {
  let hashedNonce: String
}

/// Shows the system's Sign in with Apple sheet and returns the identity token Apple issues
/// for this app. Nothing is stored here and no network request is made: the page sends the
/// token to the backend, which verifies it against Apple's keys.
class AppleSignInPlugin: Plugin, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  /// The call being answered, and the controller that must stay alive until it is.
  private var pending: (invoke: Invoke, controller: ASAuthorizationController)?

  @objc public func signIn(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SignInArgs.self)

    DispatchQueue.main.async { [weak self] in
      guard let self = self else {
        invoke.reject("Sign in with Apple is not available")
        return
      }
      guard self.pending == nil else {
        invoke.reject("Sign in with Apple is already in progress", code: "inProgress")
        return
      }

      let request = ASAuthorizationAppleIDProvider().createRequest()
      request.requestedScopes = [.fullName, .email]
      // Apple copies this into the identity token, which ties the token to this request.
      request.nonce = args.hashedNonce

      let controller = ASAuthorizationController(authorizationRequests: [request])
      controller.delegate = self
      controller.presentationContextProvider = self
      self.pending = (invoke, controller)
      controller.performRequests()
    }
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    return manager.viewController?.view.window ?? ASPresentationAnchor()
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    guard let invoke = takePending() else { return }

    guard
      let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
      let tokenData = credential.identityToken,
      let identityToken = String(data: tokenData, encoding: .utf8)
    else {
      invoke.reject("Apple did not return an identity token", code: "noIdentityToken")
      return
    }

    var result: JsonObject = ["identityToken": identityToken]
    if let givenName = credential.fullName?.givenName, !givenName.isEmpty {
      result["givenName"] = givenName
    }
    if let familyName = credential.fullName?.familyName, !familyName.isEmpty {
      result["familyName"] = familyName
    }
    invoke.resolve(result)
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    guard let invoke = takePending() else { return }

    if let authorizationError = error as? ASAuthorizationError,
      authorizationError.code == .canceled
    {
      invoke.reject("Sign in with Apple was cancelled", code: "cancelled")
      return
    }
    invoke.reject(error.localizedDescription, code: "failed")
  }

  private func takePending() -> Invoke? {
    let invoke = pending?.invoke
    pending = nil
    return invoke
  }
}

@_cdecl("init_plugin_apple_sign_in")
func initPlugin() -> Plugin {
  return AppleSignInPlugin()
}
