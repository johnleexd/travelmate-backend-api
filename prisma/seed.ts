import 'dotenv/config';
import { scryptSync } from 'node:crypto';
import { prisma } from '../src/lib/prisma.ts';

const salt = 'travelmate-demo-salt';
const passwordHash = scryptSync('Travel123!', salt, 64).toString('hex');

const demoUsers = [
  { id: 'usr_traveler', name: 'Demo Traveler', email: 'traveler@travelmate.test', role: 'traveler' as const, trustScore: 72 },
  { id: 'usr_owner', name: 'Demo Owner', email: 'owner@travelmate.test', role: 'owner' as const, trustScore: 81 },
  { id: 'usr_admin', name: 'TravelMate Admin', email: 'admin@travelmate.test', role: 'admin' as const, trustScore: 100 },
];

const stays = [
  { id: 'lst_stay', name: 'Harbor View Guesthouse', price: 4200, capacity: 8, available: 5, municipality: 'Cordova', address: 'Cordova, Cebu', imageUrl: '/beach-bg.png' },
  { id: 'lst_cordova_budget_stay', name: 'Cordova Budget Homestay', price: 750, capacity: 10, available: 10, municipality: 'Cordova', address: 'Cordova, Cebu', imageUrl: '/beach-bg.png' },
  { id: 'lst_solea_mactan', name: 'Solea Mactan Resort & Waterpark', price: 7700, capacity: 20, available: 20, municipality: 'Cordova', address: 'Victor Wahing Street, Alegria, Cordova, Cebu', imageUrl: '/solea-mactan.jpg' },
  { id: 'lst_quest_cebu', name: 'Quest Hotel Cebu', price: 5500, capacity: 16, available: 16, municipality: 'Cebu City', address: 'Archbishop Reyes Avenue, Cebu City', imageUrl: '/travel-illustration.png' },
  { id: 'lst_bai_mandaue', name: 'bai Hotel Cebu', price: 6000, capacity: 18, available: 18, municipality: 'Mandaue City', address: 'Ouano Avenue, Mandaue City', imageUrl: '/cordova-resort.png' },
  { id: 'lst_talisay_demo', name: 'Talisay City Pension Stay (Demo)', price: 1300, capacity: 8, available: 8, municipality: 'Talisay City', address: 'Talisay City, Cebu', imageUrl: '/beach-bg.png' },
  { id: 'lst_carcar_demo', name: 'Carcar Heritage Inn (Demo)', price: 1200, capacity: 8, available: 8, municipality: 'Carcar City', address: 'Carcar City, Cebu', imageUrl: '/travel-illustration.png' },
  { id: 'lst_sibonga_demo', name: 'Sibonga Pilgrim Stay (Demo)', price: 1000, capacity: 8, available: 8, municipality: 'Sibonga', address: 'Sibonga, Cebu', imageUrl: '/mountain-hero-bg.png' },
  { id: 'lst_madridejos_demo', name: 'Madridejos Coastal Inn (Demo)', price: 1100, capacity: 8, available: 8, municipality: 'Madridejos', address: 'Madridejos, Cebu', imageUrl: '/beach-bg.png' },
];

async function seed() {
  for (const user of demoUsers) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {},
      create: { ...user, emailVerified: true, profileStatus: 'verified', accountStatus: 'active', passwordHash, passwordSalt: salt },
    });
  }

  for (const stay of stays) {
    await prisma.listing.upsert({
      where: { id: stay.id },
      update: {},
      create: { ...stay, ownerId: 'usr_owner', category: 'stay', status: 'approved', description: 'TravelMate demonstration accommodation. Confirm availability before payment.', amenities: ['Wi-Fi', 'Private room', 'Local transport access'] },
    });
  }

  await prisma.listing.upsert({
    where: { id: 'lst_tour' }, update: {},
    create: { id: 'lst_tour', ownerId: 'usr_owner', name: 'Old Town Food Walk', category: 'activity', price: 1600, capacity: 12, available: 9, status: 'approved', description: 'Guided local food experience.', municipality: 'Cebu City', address: 'Cebu City', amenities: [] },
  });
}

seed()
  .then(() => console.log('TravelMate Neon demo data is ready.'))
  .finally(() => prisma.$disconnect());
