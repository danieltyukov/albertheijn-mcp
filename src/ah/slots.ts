import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { amsterdamTime } from './format.js';

export interface SlotAddress {
  street: string;
  houseNumber: number;
  houseNumberExtra?: string;
  postalCode: string;
  city: string;
}

interface RawSlotDay {
  date?: string;
  dateFormatted?: string;
  isFullyBooked?: boolean;
  slots?: {
    startTime?: string;
    endTime?: string;
    isFullyBooked?: boolean;
    shiftCode?: string;
    nudgeType?: string[];
    serviceCharge?: { price?: { amount?: number }; defaultPrice?: { amount?: number } };
  }[];
}

export interface SlotDay {
  date: string;
  fullyBooked: boolean;
  slots: {
    from: string;
    until: string;
    available: boolean;
    price?: number;
    regularPrice?: number;
    tags?: string[];
  }[];
}

export interface SlotQuery {
  address: SlotAddress;
  /** Only days from this date on (YYYY-MM-DD). */
  from?: string;
  days?: number;
  onlyAvailable?: boolean;
}

/** Home delivery slots for an address, with the delivery charge per slot. Booking happens in the app. */
export async function deliverySlots(
  ctx: AppContext,
  query: SlotQuery,
): Promise<{ days: SlotDay[]; cheapest?: string }> {
  const a = query.address;
  if (!a.street || !a.postalCode || !a.city || !a.houseNumber)
    throw new AhError(
      'INVALID_ARGUMENT',
      'Delivery slots need a street, house number, postal code and city.',
    );
  const address: Record<string, unknown> = {
    street: a.street,
    houseNumber: a.houseNumber,
    postalCode: a.postalCode.replace(/\s+/g, '').toUpperCase(),
    city: a.city,
    countryCode: 'NLD',
  };
  if (a.houseNumberExtra) address.houseNumberExtra = a.houseNumberExtra;
  const data = await ctx.ah.graphql<{ orderDeliverySlots: RawSlotDay[] | null }>(
    `query Slots($address: MemberAddressInput!) {
      orderDeliverySlots(address: $address) {
        date dateFormatted isFullyBooked
        slots { startTime endTime isFullyBooked shiftCode nudgeType serviceCharge { price { amount } defaultPrice { amount } } }
      }
    }`,
    { address },
  );
  let days: SlotDay[] = (data.orderDeliverySlots ?? []).map((day) => ({
    date: day.dateFormatted ?? day.date?.slice(0, 10) ?? '',
    fullyBooked: Boolean(day.isFullyBooked),
    slots: (day.slots ?? []).map((slot) => {
      const out: SlotDay['slots'][number] = {
        from: amsterdamTime(slot.startTime) ?? '',
        until: amsterdamTime(slot.endTime) ?? '',
        available: !slot.isFullyBooked,
      };
      const price = slot.serviceCharge?.price?.amount;
      const regular = slot.serviceCharge?.defaultPrice?.amount;
      if (price !== undefined) out.price = price;
      if (regular !== undefined && regular !== price) out.regularPrice = regular;
      if (slot.nudgeType?.length) out.tags = slot.nudgeType;
      return out;
    }),
  }));
  if (query.from) days = days.filter((d) => d.date >= query.from!);
  if (query.onlyAvailable !== false) {
    days = days
      .map((d) => ({ ...d, slots: d.slots.filter((s) => s.available) }))
      .filter((d) => d.slots.length);
  }
  days = days.slice(0, Math.min(Math.max(query.days ?? 7, 1), 14));
  let cheapest: { label: string; price: number } | undefined;
  for (const day of days)
    for (const slot of day.slots)
      if (slot.available && slot.price !== undefined && (!cheapest || slot.price < cheapest.price))
        cheapest = {
          label: `${day.date} ${slot.from}-${slot.until} (EUR ${slot.price.toFixed(2)})`,
          price: slot.price,
        };
  return cheapest ? { days, cheapest: cheapest.label } : { days };
}
