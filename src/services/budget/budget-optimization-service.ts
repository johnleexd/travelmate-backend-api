import { formatMoney, type CurrencyCode } from '../../schemas/domain.ts';

/** Pure budget assessment and optimization rules. */
export type BudgetOptimizationStatus = 'within_budget' | 'near_limit' | 'over_budget';

export interface BudgetOptimizationSuggestion {
  id: string;
  category: 'accommodation' | 'food' | 'activity' | 'transport';
  title: string;
  description: string;
  estimatedSavings: number;
  tradeoff: string;
  affectedDay?: number;
  affectedActivityTitle?: string;
}

export interface BudgetOptimization {
  status: BudgetOptimizationStatus;
  targetSpend: number;
  amountToTarget: number;
  combinedEstimatedSavings: number;
  projectedSpendIfAllApplied: number;
  remainingGapAfterSuggestions: number;
  suggestions: BudgetOptimizationSuggestion[];
  disclaimer: string;
}

interface OptimizationActivity {
  title: string;
  estimatedCost: number;
  category: string;
}

interface OptimizationDay {
  day: number;
  activities: OptimizationActivity[];
}

export interface BudgetOptimizationInput {
  budget: number;
  currency: CurrencyCode;
  reserve: number;
  plannedSpend: number;
  travelers: number;
  accommodation?: { nightlyRate: number; nights: number };
  days: OptimizationDay[];
}

function money(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}

export function buildBudgetOptimization(input: BudgetOptimizationInput): BudgetOptimization {
  const budget = money(input.budget);
  const plannedSpend = money(input.plannedSpend);
  const reserve = Math.min(budget, money(input.reserve));
  const reserveAwareTarget = money(budget - reserve);
  const status: BudgetOptimizationStatus = plannedSpend > budget
    ? 'over_budget'
    : plannedSpend > reserveAwareTarget
      ? 'near_limit'
      : 'within_budget';
  const targetSpend = status === 'over_budget' ? budget : reserveAwareTarget;
  const amountToTarget = status === 'within_budget' ? 0 : money(plannedSpend - targetSpend);
  const candidates: BudgetOptimizationSuggestion[] = [];

  if (status !== 'within_budget') {
    const accommodationTotal = input.accommodation
      ? money(input.accommodation.nightlyRate * input.accommodation.nights)
      : 0;
    if (input.accommodation && accommodationTotal > 0) {
      const targetRate = money(input.accommodation.nightlyRate * 0.8);
      candidates.push({
        id: 'compare-lower-rate-stay',
        category: 'accommodation',
        title: 'Compare a lower-rate stay',
        description: `Look for a verified stay near ${formatMoney(targetRate, input.currency)} per night or lower before changing the selected accommodation.`,
        estimatedSavings: money(accommodationTotal * 0.2),
        tradeoff: 'A lower rate may mean fewer amenities, a smaller room, or a less central location. Availability is not guaranteed.',
      });
    }

    const activities = input.days.flatMap((day) => day.activities.map((activity) => ({ ...activity, day: day.day })))
      .filter((activity) => (activity.category === 'activity' || activity.category === 'misc') && activity.estimatedCost > 0)
      .sort((left, right) => right.estimatedCost - left.estimatedCost);
    if (activities[0]) {
      const costly = activities[0];
      candidates.push({
        id: `lower-cost-activity-day-${costly.day}`,
        category: 'activity',
        title: `Review “${costly.title}”`,
        description: 'Compare a free public attraction or lower-cost activity in the same area and time window.',
        estimatedSavings: money(costly.estimatedCost * 0.75),
        tradeoff: 'The replacement may be less guided, shorter, or offer fewer inclusions. Confirm location, hours, and current price first.',
        affectedDay: costly.day,
        affectedActivityTitle: costly.title,
      });
    }

    const categoryTotal = (category: string) => input.days.reduce((total, day) => total + day.activities
      .filter((activity) => activity.category === category)
      .reduce((sum, activity) => sum + money(activity.estimatedCost), 0), 0);
    const foodTotal = categoryTotal('food');
    if (foodTotal > 0) candidates.push({
      id: 'set-meal-budget-cap',
      category: 'food',
      title: 'Set a daily meal cap',
      description: `Choose local set meals or markets for selected meals; a 20% reduction is about ${formatMoney(money(foodTotal * 0.2), input.currency)} for the group.`,
      estimatedSavings: money(foodTotal * 0.2),
      tradeoff: 'This reduces premium dining and may require checking menus or sharing dishes.',
    });

    const transportTotal = categoryTotal('transport');
    if (transportTotal > 0) candidates.push({
      id: 'compare-shared-transport',
      category: 'transport',
      title: 'Compare shared or public transport',
      description: 'Check whether selected transfers can safely use public or shared transport instead of private rides.',
      estimatedSavings: money(transportTotal * 0.3),
      tradeoff: 'Travel may take longer, involve transfers, or be impractical for luggage, accessibility needs, or late hours.',
    });
  }

  const suggestions = candidates.filter((candidate) => candidate.estimatedSavings > 0).slice(0, 4);
  const combinedEstimatedSavings = money(suggestions.reduce((sum, suggestion) => sum + suggestion.estimatedSavings, 0));
  const projectedSpendIfAllApplied = money(Math.max(0, plannedSpend - combinedEstimatedSavings));
  const remainingGapAfterSuggestions = money(Math.max(0, projectedSpendIfAllApplied - targetSpend));

  return {
    status,
    targetSpend,
    amountToTarget,
    combinedEstimatedSavings,
    projectedSpendIfAllApplied,
    remainingGapAfterSuggestions,
    suggestions,
    disclaimer: 'Planning estimates only. Nothing is changed automatically; verify current prices and availability before editing the itinerary.',
  };
}
