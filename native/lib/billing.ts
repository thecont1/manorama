import {
  Purchases,
  type CustomerInfo,
  type PurchasesCallbackId,
  type PurchasesOffering,
  type PurchasesPackage,
  type PurchasesPlugin,
} from '@revenuecat/purchases-capacitor'
import {
  PaywallPresentationConfiguration,
  RevenueCatUI,
  type RevenueCatUIPlugin,
} from '@revenuecat/purchases-capacitor-ui'

export const PRO_ENTITLEMENT = 'will_pay'
export const YEARLY_PRODUCT_ID = 'yearly'

export type NativeTier = 'free' | 'pro'

export type BillingState = {
  tier: NativeTier
  isPro: boolean
  customerInfo: CustomerInfo
}

export type BillingOptions = {
  apiKey: string
  appUserId: string
  onStateChange?: (state: BillingState) => void
}

type PurchasesClient = Pick<
  PurchasesPlugin,
  | 'configure'
  | 'getCustomerInfo'
  | 'getOfferings'
  | 'purchasePackage'
  | 'restorePurchases'
  | 'addCustomerInfoUpdateListener'
  | 'removeCustomerInfoUpdateListener'
  | 'logIn'
  | 'logOut'
>

/**
 * The native client is the presentation-side source of truth for gating the
 * paywall and ad placements. The Worker tier is promoted by the trusted
 * RevenueCat webhook in B5; native code must never write D1 directly.
 */
export const tierFromCustomerInfo = (customerInfo: CustomerInfo): NativeTier =>
  customerInfo.entitlements.active[PRO_ENTITLEMENT]?.isActive ? 'pro' : 'free'

export const billingStateFromCustomerInfo = (
  customerInfo: CustomerInfo,
): BillingState => {
  const tier = tierFromCustomerInfo(customerInfo)
  return {
    tier,
    isPro: tier === 'pro',
    customerInfo,
  }
}

export class RevenueCatBilling {
  private readonly purchases: PurchasesClient
  private readonly onStateChange?: (state: BillingState) => void
  private readonly ui: Pick<RevenueCatUIPlugin, 'presentPaywallIfNeeded' | 'presentCustomerCenter'>
  private listenerId?: PurchasesCallbackId
  private state?: BillingState
  private configured = false

  constructor(
    purchases: PurchasesClient = Purchases,
    onStateChange?: (state: BillingState) => void,
    ui: Pick<RevenueCatUIPlugin, 'presentPaywallIfNeeded' | 'presentCustomerCenter'> = RevenueCatUI,
  ) {
    this.purchases = purchases
    this.onStateChange = onStateChange
    this.ui = ui
  }

  get currentState(): BillingState | undefined {
    return this.state
  }

  async configure(options: BillingOptions): Promise<BillingState> {
    const apiKey = options.apiKey.trim()
    const appUserId = options.appUserId.trim()
    if (!apiKey) throw new Error('RevenueCat API key is required')
    if (!appUserId) throw new Error('RevenueCat app user ID is required')

    await this.purchases.configure({
      apiKey,
      appUserID: appUserId,
      // Do not collect advertising identifiers for billing. Ad consent and
      // non-personalised ads are handled separately by the AdMob adapter.
      automaticDeviceIdentifierCollectionEnabled: false,
      diagnosticsEnabled: false,
    })
    this.configured = true

    await this.removeListener()
    this.listenerId = await this.purchases.addCustomerInfoUpdateListener(
      (customerInfo) => this.applyCustomerInfo(customerInfo),
    )
    return this.refresh()
  }

  async identify(appUserId: string): Promise<BillingState> {
    const trimmed = appUserId.trim()
    if (!trimmed) throw new Error('RevenueCat app user ID is required')
    const result = await this.purchases.logIn({ appUserID: trimmed })
    return this.applyCustomerInfo(result.customerInfo)
  }

  async refresh(): Promise<BillingState> {
    const result = await this.purchases.getCustomerInfo()
    return this.applyCustomerInfo(result.customerInfo)
  }

  async offerings(): Promise<PurchasesOffering | null> {
    const result = await this.purchases.getOfferings()
    return result.current
  }

  async purchase(aPackage: PurchasesPackage): Promise<BillingState> {
    const result = await this.purchases.purchasePackage({ aPackage })
    return this.applyCustomerInfo(result.customerInfo)
  }

  async restore(): Promise<BillingState> {
    const result = await this.purchases.restorePurchases()
    return this.applyCustomerInfo(result.customerInfo)
  }

  async signOut(): Promise<void> {
    await this.removeListener()
    await this.purchases.logOut()
    this.state = undefined
    this.configured = false
  }

  async presentPaywallIfNeeded() {
    if (!this.configured) throw new Error('Sign in before opening the subscription options')
    const result = await this.ui.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: PRO_ENTITLEMENT,
      presentationConfiguration: PaywallPresentationConfiguration.FULL_SCREEN,
      displayCloseButton: true,
    })
    return { result: result.result, state: await this.refresh() }
  }

  async presentCustomerCenter(): Promise<BillingState> {
    if (!this.configured) throw new Error('Sign in before managing your subscription')
    await this.ui.presentCustomerCenter()
    return this.refresh()
  }

  private applyCustomerInfo(customerInfo: CustomerInfo): BillingState {
    const next = billingStateFromCustomerInfo(customerInfo)
    this.state = next
    this.onStateChange?.(next)
    return next
  }

  private async removeListener(): Promise<void> {
    if (!this.listenerId) return
    await this.purchases.removeCustomerInfoUpdateListener({
      listenerToRemove: this.listenerId,
    })
    this.listenerId = undefined
  }
}

export const createRevenueCatBilling = (
  options: BillingOptions,
  purchases: PurchasesClient = Purchases,
) => {
  const billing = new RevenueCatBilling(purchases, options.onStateChange)
  return {
    billing,
    configure: () => billing.configure(options),
  }
}

export type { PurchasesClient }
