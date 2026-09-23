import { Purchases, type CustomerInfo, type PurchasesCallbackId, type PurchasesOffering, type PurchasesPackage, type PurchasesPlugin } from '@revenuecat/purchases-capacitor'
import { PaywallPresentationConfiguration, RevenueCatUI, type RevenueCatUIPlugin } from '@revenuecat/purchases-capacitor-ui'

export const PRO_ENTITLEMENT = 'will_pay'
export const YEARLY_PRODUCT_ID = 'yearly'
export type NativeTier = 'free' | 'pro'
export type BillingState = { tier: NativeTier; isPro: boolean; customerInfo: CustomerInfo }
export type BillingOptions = { apiKey: string; appUserId: string; onStateChange?: (state: BillingState) => void }

type PurchasesClient = Pick<PurchasesPlugin, 'configure' | 'getCustomerInfo' | 'getOfferings' | 'purchasePackage' | 'restorePurchases' | 'addCustomerInfoUpdateListener' | 'removeCustomerInfoUpdateListener' | 'logIn' | 'logOut'>

export const tierFromCustomerInfo = (customerInfo: CustomerInfo): NativeTier => customerInfo.entitlements.active[PRO_ENTITLEMENT]?.isActive ? 'pro' : 'free'
export const billingStateFromCustomerInfo = (customerInfo: CustomerInfo): BillingState => {
  const tier = tierFromCustomerInfo(customerInfo)
  return { tier, isPro: tier === 'pro', customerInfo }
}

export class RevenueCatBilling {
  private readonly purchases: PurchasesClient
  private readonly onStateChange?: (state: BillingState) => void
  private readonly ui: Pick<RevenueCatUIPlugin, 'presentPaywallIfNeeded' | 'presentCustomerCenter'>
  private listenerId?: PurchasesCallbackId
  private state?: BillingState
  private sessionGeneration = 0
  private configured = false

  constructor(purchases: PurchasesClient = Purchases, onStateChange?: (state: BillingState) => void, ui: Pick<RevenueCatUIPlugin, 'presentPaywallIfNeeded' | 'presentCustomerCenter'> = RevenueCatUI) {
    this.purchases = purchases
    this.onStateChange = onStateChange
    this.ui = ui
  }
  get currentState(): BillingState | undefined { return this.state }

  async configure(options: BillingOptions): Promise<BillingState> {
    const apiKey = options.apiKey.trim()
    const appUserId = options.appUserId.trim()
    if (!apiKey) throw new Error('RevenueCat API key is required')
    if (!appUserId) throw new Error('RevenueCat app user ID is required')
    const generation = ++this.sessionGeneration
    this.configured = false
    this.state = undefined
    await this.purchases.configure({ apiKey, appUserID: appUserId, automaticDeviceIdentifierCollectionEnabled: false, diagnosticsEnabled: false })
    await this.removeListener()
    if (generation !== this.sessionGeneration) throw new Error('RevenueCat session changed during configuration')
    const listenerId = await this.purchases.addCustomerInfoUpdateListener((customerInfo) => this.applyCustomerInfo(customerInfo, generation))
    if (generation !== this.sessionGeneration) {
      await this.purchases.removeCustomerInfoUpdateListener({ listenerToRemove: listenerId })
      throw new Error('RevenueCat session changed during configuration')
    }
    this.listenerId = listenerId
    this.configured = true
    return this.refresh(generation)
  }
  async identify(appUserId: string): Promise<BillingState> {
    const trimmed = appUserId.trim()
    if (!trimmed) throw new Error('RevenueCat app user ID is required')
    const generation = this.sessionGeneration
    const result = await this.purchases.logIn({ appUserID: trimmed })
    return this.applyCustomerInfo(result.customerInfo, generation)
  }
  async refresh(generation = this.sessionGeneration): Promise<BillingState> {
    const result = await this.purchases.getCustomerInfo()
    return this.applyCustomerInfo(result.customerInfo, generation)
  }
  async offerings(): Promise<PurchasesOffering | null> { return (await this.purchases.getOfferings()).current }
  async purchase(aPackage: PurchasesPackage): Promise<BillingState> {
    const generation = this.sessionGeneration
    const result = await this.purchases.purchasePackage({ aPackage })
    return this.applyCustomerInfo(result.customerInfo, generation)
  }
  async restore(): Promise<BillingState> {
    const generation = this.sessionGeneration
    const result = await this.purchases.restorePurchases()
    return this.applyCustomerInfo(result.customerInfo, generation)
  }
  async signOut(): Promise<void> {
    this.sessionGeneration += 1
    this.configured = false
    this.state = undefined
    await this.removeListener()
    await this.purchases.logOut()
  }
  async presentPaywallIfNeeded() {
    if (!this.configured) throw new Error('Sign in before opening the subscription options')
    const result = await this.ui.presentPaywallIfNeeded({ requiredEntitlementIdentifier: PRO_ENTITLEMENT, presentationConfiguration: PaywallPresentationConfiguration.FULL_SCREEN, displayCloseButton: true })
    return { result: result.result, state: await this.refresh() }
  }
  async presentCustomerCenter(): Promise<BillingState> {
    if (!this.configured) throw new Error('Sign in before managing your subscription')
    await this.ui.presentCustomerCenter()
    return this.refresh()
  }
  private applyCustomerInfo(customerInfo: CustomerInfo, generation: number): BillingState {
    const next = billingStateFromCustomerInfo(customerInfo)
    if (!this.configured || generation !== this.sessionGeneration) return next
    this.state = next
    this.onStateChange?.(next)
    return next
  }
  private async removeListener(): Promise<void> {
    if (!this.listenerId) return
    await this.purchases.removeCustomerInfoUpdateListener({ listenerToRemove: this.listenerId })
    this.listenerId = undefined
  }
}

export const createRevenueCatBilling = (options: BillingOptions, purchases: PurchasesClient = Purchases) => {
  const billing = new RevenueCatBilling(purchases, options.onStateChange)
  return { billing, configure: () => billing.configure(options) }
}
export type { PurchasesClient }
