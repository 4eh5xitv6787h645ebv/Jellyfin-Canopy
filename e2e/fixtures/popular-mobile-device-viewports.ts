/**
 * Responsive coverage roster assembled 2026-07-24.
 *
 * No free, authoritative model-level global "top 50" is published. This
 * reproducible proxy combines every distinct phone in Counterpoint's global
 * Top-10 sell-through charts from 2022 through Q1 2026 (40 phones) with ten
 * current tablet representatives across Omdia's Q1 2026 top-five vendors.
 * Tablet rows are vendor-coverage representatives, not model sales ranks.
 *
 * Popularity sources:
 * - https://counterpointresearch.com/en/insights/iphone-17-global-best-selling-smartphone-in-q1-2026-top-10-take-25-percent-share
 * - https://counterpointresearch.com/en/insights/global-smartphone-sales-top-10-best-sellers
 * - https://counterpointresearch.com/en/insights/top-10-best-selling-smartphones-in-2024
 * - https://korea.counterpointresearch.com/2023%EB%85%84-%EC%97%B0%EA%B0%84-%ED%8C%90%EB%A7%A4%EB%9F%89-top-10-%EC%8A%A4%EB%A7%88%ED%8A%B8%ED%8F%B0-%EB%AA%A8%EB%8D%B8-%EC%A4%91-%EC%95%A0%ED%94%8C%EC%9D%B4-%EC%83%81%EC%9C%84-7%EA%B0%9C%EB%A5%BC/
 * - https://korea.counterpointresearch.com/%EC%A7%80%EB%82%9C%ED%95%B4-%EA%B0%80%EC%9E%A5-%EB%A7%8E%EC%9D%B4-%ED%8C%94%EB%A6%B0-%EC%8A%A4%EB%A7%88%ED%8A%B8%ED%8F%B0-%EC%83%81%EC%9C%84-10%EA%B0%9C-%EC%A4%91-8%EA%B0%9C%EA%B0%80-%EC%95%84/
 * - https://omdia.tech.informa.com/pr/2026/may/global-tablet-market-sees-marginal-growth-at-0point1-percent-in-q1-2026-as-demand-outlook-weakens
 *
 * Viewports are portrait browser-content coverage proxies in CSS pixels.
 * "Playwright" rows use the current upstream descriptor registry. Every other
 * row records its physical-pixel/density calculation or published logical CSS
 * screen input in `viewportDerivation`; browser chrome and Android Display
 * Zoom can vary the effective viewport. The permanent 320px stress case
 * therefore remains intentionally outside this popularity roster.
 *
 * Viewport sources/semantics:
 * - https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json
 * - https://playwright.dev/docs/next/emulation
 */

interface PopularMobileDeviceBase {
    rosterOrder: number;
    name: string;
    category: 'phone' | 'tablet';
    popularity: string;
    viewport: { width: number; height: number };
}

export type PopularMobileDevice = PopularMobileDeviceBase & (
    | { viewportBasis: 'Playwright'; viewportDerivation?: never }
    | {
        viewportBasis: 'reference' | 'density proxy';
        viewportDerivation: string;
    }
);

export const POPULAR_MOBILE_DEVICES: ReadonlyArray<PopularMobileDevice> = [
    { rosterOrder: 1, name: 'Apple iPhone 17', category: 'phone', popularity: 'Counterpoint Q1 2026 #1', viewport: { width: 402, height: 681 }, viewportBasis: 'Playwright' },
    { rosterOrder: 2, name: 'Apple iPhone 17 Pro Max', category: 'phone', popularity: 'Counterpoint Q1 2026 #2', viewport: { width: 440, height: 763 }, viewportBasis: 'Playwright' },
    { rosterOrder: 3, name: 'Apple iPhone 17 Pro', category: 'phone', popularity: 'Counterpoint Q1 2026 #3', viewport: { width: 402, height: 681 }, viewportBasis: 'Playwright' },
    { rosterOrder: 4, name: 'Samsung Galaxy A07 4G', category: 'phone', popularity: 'Counterpoint Q1 2026 #4', viewport: { width: 360, height: 800 }, viewportBasis: 'density proxy', viewportDerivation: '720×1600 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 5, name: 'Samsung Galaxy A17 5G', category: 'phone', popularity: 'Counterpoint Q1 2026 #6', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 6, name: 'Apple iPhone 16', category: 'phone', popularity: 'Counterpoint Q1 2026 #5; 2025 annual #1', viewport: { width: 393, height: 659 }, viewportBasis: 'Playwright' },
    { rosterOrder: 7, name: 'Samsung Galaxy A56', category: 'phone', popularity: 'Counterpoint Q1 2026 #9', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 8, name: 'Samsung Galaxy A36', category: 'phone', popularity: 'Counterpoint Q1 2026 #8', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 9, name: 'Samsung Galaxy A17 4G', category: 'phone', popularity: 'Counterpoint Q1 2026 #7', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 10, name: 'Xiaomi Redmi A5', category: 'phone', popularity: 'Counterpoint Q1 2026 #10', viewport: { width: 360, height: 820 }, viewportBasis: 'density proxy', viewportDerivation: '720×1640 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 11, name: 'Apple iPhone 16 Pro Max', category: 'phone', popularity: 'Counterpoint 2025 annual #2', viewport: { width: 440, height: 763 }, viewportBasis: 'Playwright' },
    { rosterOrder: 12, name: 'Apple iPhone 16 Pro', category: 'phone', popularity: 'Counterpoint 2025 annual #3', viewport: { width: 402, height: 681 }, viewportBasis: 'Playwright' },
    { rosterOrder: 13, name: 'Samsung Galaxy A16 5G', category: 'phone', popularity: 'Counterpoint 2025 annual #5', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 14, name: 'Samsung Galaxy A06 4G', category: 'phone', popularity: 'Counterpoint 2025 annual #6', viewport: { width: 360, height: 800 }, viewportBasis: 'density proxy', viewportDerivation: '720×1600 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 15, name: 'Apple iPhone 15', category: 'phone', popularity: 'Counterpoint 2025 annual #8', viewport: { width: 393, height: 659 }, viewportBasis: 'Playwright' },
    { rosterOrder: 16, name: 'Samsung Galaxy S25 Ultra', category: 'phone', popularity: 'Counterpoint 2025 annual #9', viewport: { width: 480, height: 1040 }, viewportBasis: 'density proxy', viewportDerivation: '1440×3120 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 17, name: 'Apple iPhone 16e', category: 'phone', popularity: 'Counterpoint 2025 annual #10', viewport: { width: 390, height: 651 }, viewportBasis: 'Playwright' },
    { rosterOrder: 18, name: 'Samsung Galaxy A16 4G', category: 'phone', popularity: 'Counterpoint Q3 2025 #9', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 19, name: 'Xiaomi Redmi 14C 4G', category: 'phone', popularity: 'Counterpoint Q2 2025 #9; Q1 #8', viewport: { width: 360, height: 820 }, viewportBasis: 'density proxy', viewportDerivation: '720×1640 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 20, name: 'Samsung Galaxy A55 5G', category: 'phone', popularity: 'Counterpoint Q1 2025 #9', viewport: { width: 480, height: 1040 }, viewportBasis: 'Playwright' },
    { rosterOrder: 21, name: 'Apple iPhone 16 Plus', category: 'phone', popularity: 'Counterpoint Q1 2025 #10', viewport: { width: 430, height: 739 }, viewportBasis: 'Playwright' },
    { rosterOrder: 22, name: 'Apple iPhone 15 Pro Max', category: 'phone', popularity: 'Counterpoint 2024 annual #2', viewport: { width: 430, height: 739 }, viewportBasis: 'Playwright' },
    { rosterOrder: 23, name: 'Apple iPhone 15 Pro', category: 'phone', popularity: 'Counterpoint 2024 annual #3', viewport: { width: 393, height: 659 }, viewportBasis: 'Playwright' },
    { rosterOrder: 24, name: 'Samsung Galaxy A15 5G', category: 'phone', popularity: 'Counterpoint 2024 annual #4', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 25, name: 'Samsung Galaxy A15 4G', category: 'phone', popularity: 'Counterpoint 2024 annual #6', viewport: { width: 360, height: 780 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2340 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 26, name: 'Samsung Galaxy S24 Ultra', category: 'phone', popularity: 'Counterpoint 2024 annual #7', viewport: { width: 480, height: 1040 }, viewportBasis: 'density proxy', viewportDerivation: '1440×3120 hardware pixels ÷ 3 logical-density proxy' },
    { rosterOrder: 27, name: 'Apple iPhone 14', category: 'phone', popularity: 'Counterpoint 2024 annual #8; 2023 #1', viewport: { width: 390, height: 664 }, viewportBasis: 'Playwright' },
    { rosterOrder: 28, name: 'Samsung Galaxy A05', category: 'phone', popularity: 'Counterpoint 2024 annual #10', viewport: { width: 360, height: 800 }, viewportBasis: 'density proxy', viewportDerivation: '720×1600 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 29, name: 'Apple iPhone 14 Pro Max', category: 'phone', popularity: 'Counterpoint 2023 annual #2', viewport: { width: 430, height: 740 }, viewportBasis: 'Playwright' },
    { rosterOrder: 30, name: 'Apple iPhone 14 Pro', category: 'phone', popularity: 'Counterpoint 2023 annual #3', viewport: { width: 393, height: 660 }, viewportBasis: 'Playwright' },
    { rosterOrder: 31, name: 'Apple iPhone 13', category: 'phone', popularity: 'Counterpoint 2023 annual #4; 2022 #1', viewport: { width: 390, height: 664 }, viewportBasis: 'Playwright' },
    { rosterOrder: 32, name: 'Samsung Galaxy A14 5G', category: 'phone', popularity: 'Counterpoint 2023 annual #8', viewport: { width: 360, height: 803 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2408 hardware pixels ÷ 3, height rounded to nearest CSS pixel' },
    { rosterOrder: 33, name: 'Samsung Galaxy A04e', category: 'phone', popularity: 'Counterpoint 2023 annual #9', viewport: { width: 360, height: 800 }, viewportBasis: 'density proxy', viewportDerivation: '720×1600 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 34, name: 'Samsung Galaxy A14 4G', category: 'phone', popularity: 'Counterpoint 2023 annual #10', viewport: { width: 360, height: 803 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2408 hardware pixels ÷ 3, height rounded to nearest CSS pixel' },
    { rosterOrder: 35, name: 'Apple iPhone 13 Pro Max', category: 'phone', popularity: 'Counterpoint 2022 annual #2', viewport: { width: 428, height: 746 }, viewportBasis: 'Playwright' },
    { rosterOrder: 36, name: 'Samsung Galaxy A13', category: 'phone', popularity: 'Counterpoint 2022 annual #4', viewport: { width: 360, height: 803 }, viewportBasis: 'density proxy', viewportDerivation: '1080×2408 hardware pixels ÷ 3, height rounded to nearest CSS pixel' },
    { rosterOrder: 37, name: 'Apple iPhone 13 Pro', category: 'phone', popularity: 'Counterpoint 2022 annual #5', viewport: { width: 390, height: 664 }, viewportBasis: 'Playwright' },
    { rosterOrder: 38, name: 'Apple iPhone 12', category: 'phone', popularity: 'Counterpoint 2022 annual #6', viewport: { width: 390, height: 664 }, viewportBasis: 'Playwright' },
    { rosterOrder: 39, name: 'Apple iPhone SE (2022)', category: 'phone', popularity: 'Counterpoint 2022 annual #9', viewport: { width: 375, height: 667 }, viewportBasis: 'Playwright' },
    { rosterOrder: 40, name: 'Samsung Galaxy A03', category: 'phone', popularity: 'Counterpoint 2022 annual #10', viewport: { width: 360, height: 800 }, viewportBasis: 'density proxy', viewportDerivation: '720×1600 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 41, name: 'Apple iPad (11th gen, 2025)', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #1 representative', viewport: { width: 656, height: 944 }, viewportBasis: 'Playwright' },
    { rosterOrder: 42, name: 'Apple iPad Air 11-inch', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #1 representative; Air cited as growth driver', viewport: { width: 820, height: 1180 }, viewportBasis: 'reference', viewportDerivation: 'Published 820×1180 portrait logical CSS screen; browser chrome varies' },
    { rosterOrder: 43, name: 'Apple iPad Air 13-inch', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #1 representative; Air cited as growth driver', viewport: { width: 1024, height: 1366 }, viewportBasis: 'reference', viewportDerivation: 'Published 1024×1366 portrait logical CSS screen; browser chrome varies' },
    { rosterOrder: 44, name: 'Apple iPad Pro 11-inch', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #1 portfolio representative', viewport: { width: 834, height: 1194 }, viewportBasis: 'Playwright' },
    { rosterOrder: 45, name: 'Apple iPad mini (6th/7th gen)', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #1 portfolio representative', viewport: { width: 744, height: 1133 }, viewportBasis: 'reference', viewportDerivation: 'Published 744×1133 portrait logical CSS screen; browser chrome varies' },
    { rosterOrder: 46, name: 'Samsung Galaxy Tab A9+', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #2 representative', viewport: { width: 800, height: 1280 }, viewportBasis: 'density proxy', viewportDerivation: '1200×1920 hardware pixels ÷ 1.5 logical-density proxy' },
    { rosterOrder: 47, name: 'Samsung Galaxy Tab S10+', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #2 representative', viewport: { width: 876, height: 1400 }, viewportBasis: 'density proxy', viewportDerivation: '1752×2800 hardware pixels ÷ 2 logical-density proxy' },
    { rosterOrder: 48, name: 'Huawei MatePad 11.5', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #3 representative', viewport: { width: 800, height: 1280 }, viewportBasis: 'density proxy', viewportDerivation: 'Standard 800×1280 Android tablet coverage proxy for the vendor representative' },
    { rosterOrder: 49, name: 'Lenovo Tab M11', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #4 representative', viewport: { width: 800, height: 1280 }, viewportBasis: 'density proxy', viewportDerivation: '1200×1920 hardware pixels ÷ 1.5 logical-density proxy' },
    { rosterOrder: 50, name: 'Xiaomi Pad 7', category: 'tablet', popularity: 'Omdia Q1 2026 vendor #5 representative', viewport: { width: 800, height: 1200 }, viewportBasis: 'density proxy', viewportDerivation: '2136×3200 hardware pixels ÷ ≈2.667, width normalized to 800 CSS pixels' },
];
