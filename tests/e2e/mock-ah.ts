import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small stand-in for api.ah.nl that speaks just enough REST and GraphQL for the
 * end-to-end tests: tokens, search, product details, bonus pricing and a stateful basket.
 */
export interface MockAh {
  url: string;
  requests: { method: string; path: string; operation?: string; auth?: string }[];
  basket: Map<number, number>;
  orderBooked: boolean;
  close(): Promise<void>;
}

const CATALOGUE = [
  {
    webshopId: 10,
    title: 'AH Scharrel kipfilet',
    salesUnitSize: '300 g',
    priceBeforeBonus: 3.99,
    isOrderable: true,
    mainCategory: 'Vlees',
  },
  {
    webshopId: 20,
    title: 'AH Zilvervliesrijst',
    salesUnitSize: '1 kg',
    priceBeforeBonus: 2.19,
    isOrderable: true,
    mainCategory: 'Pasta, rijst',
  },
  {
    webshopId: 30,
    title: 'AH Broccoli',
    salesUnitSize: '500 g',
    priceBeforeBonus: 1.49,
    currentPrice: 0.99,
    isBonus: true,
    bonusMechanism: 'VOOR 0.99',
    promotionType: 'NATIONAL',
    isOrderable: true,
  },
];

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });

export async function startMockAh(): Promise<MockAh> {
  const mock = { requests: [], basket: new Map<number, number>(), orderBooked: false } as unknown as MockAh;
  const basketView = () => {
    const items = [...mock.basket].map(([id, quantity]) => {
      const p = CATALOGUE.find((c) => c.webshopId === id)!;
      return {
        id,
        quantity,
        product: {
          id,
          title: p.title,
          salesUnitSize: p.salesUnitSize,
          priceV2: { now: { amount: p.currentPrice ?? p.priceBeforeBonus } },
        },
      };
    });
    return {
      id: 'basket',
      itemsInList: mock.orderBooked ? [] : items,
      itemsInOrder: mock.orderBooked ? items : null,
      notes: [],
      summary: mock.orderBooked
        ? { shoppingType: 'DELIVERY', deliveryDate: '2026-10-31' }
        : { shoppingType: null, deliveryDate: null },
    };
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const raw = await read(req);
    const body = raw ? (JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> }) : {};
    const operation =
      url.pathname === '/graphql' ? /\{\s*([A-Za-z_]\w*)/.exec(body.query ?? '')?.[1] : undefined;
    const auth = req.headers.authorization;
    mock.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      ...(operation ? { operation } : {}),
      ...(auth ? { auth } : {}),
    });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/mobile-auth/v1/auth/token/anonymous')
      return send(200, { access_token: 'anon', refresh_token: 'r', expires_in: 600000 });
    if (!auth) return send(401, { error: 'unauthorized' });
    if (url.pathname.startsWith('/mobile-services/') && req.headers['x-application'] !== 'AHWEBSHOP')
      return send(500, { message: "Can not find application: 'null'" });
    if (url.pathname === '/mobile-services/product/search/v2') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = CATALOGUE.filter((p) =>
        words.some((w) => p.title.toLowerCase().includes(w.replace(/s$/, ''))),
      );
      return send(200, { page: { totalElements: hits.length, totalPages: 1, number: 0 }, products: hits });
    }
    if (url.pathname === '/mobile-services/product/search/v2/products') {
      const ids = url.searchParams.getAll('ids').map(Number);
      return send(200, ids.map((id) => CATALOGUE.find((p) => p.webshopId === id)).filter(Boolean));
    }
    const detail = /^\/mobile-services\/product\/detail\/v4\/fir\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const p = CATALOGUE.find((c) => c.webshopId === Number(detail[1]));
      if (!p) return send(404, {});
      return send(200, {
        productId: p.webshopId,
        productCard: p,
        properties: { nutriscore: ['A'] },
        tradeItem: {
          nutritionalInformation: {
            nutrientHeaders: [
              {
                nutrientBasisQuantity: { value: 100, measurementUnitCode: { value: 'g' } },
                nutrientDetail: [
                  {
                    nutrientTypeCode: { value: 'ENER-' },
                    quantityContained: [{ value: 110, measurementUnitCode: { value: 'kcal' } }],
                  },
                  {
                    nutrientTypeCode: { value: 'PRO-' },
                    quantityContained: [
                      { value: p.webshopId === 10 ? 23 : 3, measurementUnitCode: { value: 'g' } },
                    ],
                  },
                ],
              },
            ],
          },
        },
      });
    }
    if (url.pathname === '/mobile-services/order/v1/summaries/active')
      return mock.orderBooked ? send(200, { id: 5 }) : send(404, {});
    if (url.pathname === '/mobile-services/order/v1/5/details-grouped-by-taxonomy')
      return send(200, { orderId: 5, closingTime: '2026-10-30T22:59:00Z' });
    if (url.pathname === '/graphql') {
      const v = body.variables ?? {};
      switch (operation) {
        case 'basket':
          return auth === 'Bearer anon'
            ? send(200, { errors: [{ message: 'unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] })
            : send(200, { data: { basket: basketView() } });
        case 'basketItemsAdd':
          for (const item of v.items as { id: number; quantity: number }[])
            mock.basket.set(item.id, (mock.basket.get(item.id) ?? 0) + item.quantity);
          return send(200, { data: { basketItemsAdd: { status: 'SUCCESS', result: basketView() } } });
        case 'basketItemsUpdate':
          for (const item of v.items as { id: number; quantity: number }[]) {
            if (item.quantity === 0) mock.basket.delete(item.id);
            else mock.basket.set(item.id, item.quantity);
          }
          return send(200, { data: { basketItemsUpdate: { status: 'SUCCESS', result: basketView() } } });
        case 'totalPrice': {
          const items = v.products as { id: number; quantity: number }[];
          let before = 0;
          let discount = 0;
          for (const item of items) {
            const p = CATALOGUE.find((c) => c.webshopId === item.id);
            if (!p) continue;
            before += p.priceBeforeBonus * item.quantity;
            if (p.currentPrice !== undefined)
              discount += (p.priceBeforeBonus - p.currentPrice) * item.quantity;
          }
          return send(200, {
            data: {
              totalPrice: {
                withoutDiscount: { amount: before },
                discount: { amount: Math.round(discount * 100) / 100 },
              },
            },
          });
        }
        default:
          return send(400, { errors: [{ message: `not mocked: ${operation}` }] });
      }
    }
    return send(404, { message: 'not mocked' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}
