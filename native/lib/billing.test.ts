import { describe, expect, test } from 'bun:test'
import type { CustomerInfo, PurchasesPackage } from '@revenuecat/purchases-capacitor'
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
    const info = customerInfo({ pro: { isActive: true } })
    expect(tierFromCustomerInfo(info)).toBe('pro')
    expect(billingStateFromCustomerInfo(info).isPro).toBe(true)
  })

  test('maps missing or inactive pro entitlements to the free tier', () => {
    expect(tierFromCustomerInfo(customerInfo())).toBe('free')
    expect(tierFromCustomerInfo(customerInfo({ pro: { isActive: false } }))).toBe('free')
  })
})

describe('RevenueCatBilling', () => {
  test('configures, refreshes, and notifies from customer info', async () => {
    const info = customerInfo({ pro: { isActive: true } })
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
    const info = customerInfo({ pro: { isActive: true } })
    const fake = fakePurchases(info)
    const billing = new RevenueCatBilling(fake)
    await billing.configure({ apiKey: 'key', appUserId: 'account' })

    expect((await billing.purchase(packageStub)).isPro).toBe(true)
    expect((await billing.restore()).tier).toBe('pro')
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
})
