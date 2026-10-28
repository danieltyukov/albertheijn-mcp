import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import type { SlotAddress } from './slots.js';

interface RawMember {
  id?: number | string;
  emailAddress?: string;
  name?: { first?: string; last?: string };
  address?: {
    street?: string;
    houseNumber?: number | string;
    houseNumberExtra?: string | null;
    postalCode?: string;
    city?: string;
    countryCode?: string;
  } | null;
  cards?: { bonus?: string | null; gall?: string | null; airmiles?: string | null } | null;
  isB2B?: boolean;
}

export interface MemberProfile {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  address?: string;
  /** Last four digits only; the full number is never returned to the model. */
  bonusCard?: string;
  hasAirMiles?: boolean;
  business?: boolean;
}

const MEMBER = `query FetchMember { member {
  id emailAddress isB2B
  name { first last }
  address { street houseNumber houseNumberExtra postalCode city countryCode }
  cards { bonus gall airmiles }
} }`;

async function rawMember(ctx: AppContext): Promise<RawMember> {
  const data = await ctx.ah.graphql<{ member: RawMember | null }>(
    MEMBER,
    {},
    { auth: 'user', allowPartial: true },
  );
  if (!data.member) throw new AhError('FORMAT_CHANGED', 'Albert Heijn returned no member profile.');
  return data.member;
}

const mask = (value: string | null | undefined): string | undefined =>
  value ? `${'*'.repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}` : undefined;

export async function memberProfile(ctx: AppContext): Promise<MemberProfile> {
  const raw = await rawMember(ctx);
  const profile: MemberProfile = {};
  if (raw.id !== undefined) profile.id = String(raw.id);
  if (raw.name?.first) profile.firstName = raw.name.first;
  if (raw.name?.last) profile.lastName = raw.name.last;
  if (raw.emailAddress) profile.email = raw.emailAddress;
  const a = raw.address;
  if (a?.street) {
    profile.address =
      `${a.street} ${a.houseNumber ?? ''}${a.houseNumberExtra ?? ''}, ${a.postalCode ?? ''} ${a.city ?? ''}`
        .replace(/\s+/g, ' ')
        .trim();
  }
  const card = mask(raw.cards?.bonus);
  if (card) profile.bonusCard = card;
  if (raw.cards?.airmiles) profile.hasAirMiles = true;
  if (raw.isB2B) profile.business = true;
  return profile;
}

/** The member's delivery address in the shape the slots query needs. */
export async function memberAddress(ctx: AppContext): Promise<SlotAddress> {
  const a = (await rawMember(ctx)).address;
  const houseNumber = Number(a?.houseNumber);
  if (!a?.street || !a.postalCode || !a.city || !Number.isFinite(houseNumber)) {
    throw new AhError('NOT_FOUND', 'Your Albert Heijn profile has no complete address. Pass one explicitly.');
  }
  const address: SlotAddress = { street: a.street, houseNumber, postalCode: a.postalCode, city: a.city };
  if (a.houseNumberExtra) address.houseNumberExtra = a.houseNumberExtra;
  return address;
}
