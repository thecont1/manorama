import { describe, expect, test } from 'bun:test'
import type { CustomerInfo, PurchasesPackage } from '@revenuecat/purchases-capacitor'
import { PAYWALL_RESULT } from '@revenuecat/purchases-capacitor-ui'
import {
  RevenueCatBilling,
  billingStateFromCustomerInfo,
  tierFromCustomerInfo,
  type PurchasesClient,
} from './billing'

const customerInfo = (active: Record<string, { isActive: boolean }> = {}) =>
  ({ entitlements: { active } } as CustomerInfo)

const packageStub = {} as PurchasesPackage

type FakePurchases = PurchasesClient & {
  configured?: unknown
  listener?: (next: CustomerInfo) => void
  removed?: string
  loggedIn?: string
  loggedOut?: boolean
}

const fakePurchases = (info: CustomerInfo): FakePurchases => {
  const fake = {
    configure: async (configuration: unknown) => {
      fake.configured = configuration
    },
    getCustomerInfo: async () => ({ customerInfo: info }),
    getOfferings: async () => ({ all: {}, current: null }),
    purchasePackage: async () => ({
      productIdentifier: 'manorama_pro_monthly',
      customerInfo: info,
      transaction: {} as never,
    }),
    restorePurchases: async () => ({ customerInfo: info }),
    addCustomerInfoUpdateListener: async (listener: (next: CustomerInfo) => void) => {
      fake.listener = listener
      return 'listener-1'
    },
    removeCustomerInfoUpdateListener: async ({ listenerToRemove }: { listenerToRemove: string }) => {
      fake.removed = listenerToRemove
      return { wasRemoved: true }
    },
    logIn: async ({ appUserID }: { appUserID: string }) => {
      fake.loggedIn = appUserID
      return { created: false, customerInfo: info }
    },
    logOut: async () => {
      fake.loggedOut = true
      return { customerInfo: info }
    },
  } as FakePurchases
  return fake
}

describe('RevenueCat entitlement mapping', () => {
  test('maps an active pro entitlement to the pro tier', () => {
    const info = customerInfo({ will_pay: { isActive: true } })
    expect(tierFromCustomerInfo(info)).toBe('pro')
    expect(billingStateFromCustomerInfo(info).isPro).toBe(true)
  })

  test('maps missing or inactive pro entitlements to the free tier', () => {
    expect(tierFromCustomerInfo(customerInfo())).toBe('free')
    expect(tierFromCustomerInfo(customerInfo({ will_pay: { isActive: false } }))).toBe('free')
  })
})

describe('RevenueCatBilling', () => {
  test('configures, refreshes, and notifies from customer info', async () => {
    const info = customerInfo({ will_pay: { isActive: true } })
    const fake = fakePurchases(info)
    const seen: string[] = []
    const billing = new RevenueCatBilling(fake, (state) => seen.push(state.tier))

    const state = await billing.configure({
      apiKey: 'public_sdk_key',
      appUserId: 'dropbox-account-1',
    })

    expect(fake.configured).toEqual({
      apiKey: 'public_sdk_key',
      appUserID: 'dropbox-account-1',
      automaticDeviceIdentifierCollectionEnabled: false,
      diagnosticsEnabled: false,
    })
    expect(state.tier).toBe('pro')
    expect(seen).toEqual(['pro'])
  })

  test('refreshes after purchase and restores', async () => {
    const info = customerInfo({ will_pay: { isActive: true } })
    const fake = fakePurchases(info)
    const billing = new RevenueCatBilling(fake)
    await billing.configure({ apiKey: 'key', appUserId: 'account' })

    expect((await billing.purchase(packageStub)).isPro).toBe(true)
    expect((await billing.restore()).tier).toBe('pro')
  })

  test('presents the hosted paywall for will_pay and opens Customer Center', async () => {
    const fake = fakePurchases(customerInfo({ will_pay: { isActive: true } }))
    let paywallOptions: unknown
    let customerCenterOpened = false
    const ui = {
      presentPaywallIfNeeded: async (options: unknown) => {
        paywallOptions = options
        return { result: PAYWALL_RESULT.PURCHASED }
      },
      presentCustomerCenter: async () => {
        customerCenterOpened = true
      },
    }
    const billing = new RevenueCatBilling(fake, undefined, ui)
    await billing.configure({ apiKey: 'key', appUserId: 'account' })
    await billing.presentPaywallIfNeeded()
    await billing.presentCustomerCenter()

    expect(paywallOptions).toMatchObject({
      requiredEntitlementIdentifier: 'will_pay',
    })
    expect(customerCenterOpened).toBe(true)
  })

  test('removes its listener before signing out', async () => {
    const fake = fakePurchases(customerInfo())
    const billing = new RevenueCatBilling(fake)
    await billing.configure({ apiKey: 'key', appUserId: 'account' })
    await billing.signOut()

    expect(fake.removed).toBe('listener-1')
    expect(fake.loggedOut).toBe(true)
    expect(billing.currentState).toBeUndefined()
  })

  test('clears state immediately and ignores queued updates during pending logout', async () => {
    const info = customerInfo({ will_pay: { isActive: true } })
    const fake = fakePurchases(info)
    let finishLogout!: () => void
    fake.logOut = async () => {
      await new Promise<void>((resolve) => { finishLogout = resolve })
      return { customerInfo: info }
    }
    const seen: string[] = []
    const billing = new RevenueCatBilling(fake, (state) => seen.push(state.tier))
    await billing.configure({ apiKey: 'key', appUserId: 'account' })

    const logout = billing.signOut()
    expect(billing.currentState).toBeUndefined()
    fake.listener?.(info)
    expect(billing.currentState).toBeUndefined()
    expect(seen).toEqual(['pro'])

    await Promise.resolve()
    await Promise.resolve()
    finishLogout()
    await logout
    expect(billing.currentState).toBeUndefined()
    expect(seen).toEqual(['pro'])
  })

  test('ignores a delayed purchase result after the account changes', async () => {
    const paidInfo = customerInfo({ will_pay: { isActive: true } })
    const freeInfo = customerInfo()
    const fake = fakePurchases(paidInfo)
    let finishPurchase!: () => void
    fake.purchasePackage = async () => {
      await new Promise<void>((resolve) => { finishPurchase = resolve })
      return {
        productIdentifier: 'yearly',
        customerInfo: paidInfo,
        transaction: {} as never,
      }
    }
    const seen: string[] = []
    const billing = new RevenueCatBilling(fake, (state) => seen.push(state.tier))
    await billing.configure({ apiKey: 'key', appUserId: 'account-a' })

    const purchase = billing.purchase(packageStub)
    await Promise.resolve()
    await billing.signOut()
    fake.getCustomerInfo = async () => ({ customerInfo: freeInfo })
    await billing.configure({ apiKey: 'key', appUserId: 'account-b' })
    expect(billing.currentState?.tier).toBe('free')
    expect(seen).toEqual(['pro', 'free'])

    finishPurchase()
    await purchase
    expect(billing.currentState?.tier).toBe('free')
    expect(seen).toEqual(['pro', 'free'])
  })

  test('ignores a delayed restore result after the account changes', async () => {
    const paidInfo = customerInfo({ will_pay: { isActive: true } })
    const freeInfo = customerInfo()
    const fake = fakePurchases(paidInfo)
    let finishRestore!: () => void
    fake.restorePurchases = async () => {
      await new Promise<void>((resolve) => { finishRestore = resolve })
      return { customerInfo: paidInfo }
    }
    const seen: string[] = []
    const billing = new RevenueCatBilling(fake, (state) => seen.push(state.tier))
    await billing.configure({ apiKey: 'key', appUserId: 'account-a' })

    const restore = billing.restore()
    await Promise.resolve()
    await billing.signOut()
    fake.getCustomerInfo = async () => ({ customerInfo: freeInfo })
    await billing.configure({ apiKey: 'key', appUserId: 'account-b' })
    expect(billing.currentState?.tier).toBe('free')
    expect(seen).toEqual(['pro', 'free'])

    finishRestore()
    await restore
    expect(billing.currentState?.tier).toBe('free')
    expect(seen).toEqual(['pro', 'free'])
  })
})
