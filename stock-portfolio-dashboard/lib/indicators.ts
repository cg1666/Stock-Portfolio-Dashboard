export function calculateSma(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / period;
}

function calculateEmaSeries(values: number[], period: number): number[] {
  if (values.length < period) {
    return [];
  }

  const smoothing = 2 / (period + 1);
  const emaSeries: number[] = [];

  // Seed EMA with SMA of the first period for a stable starting value.
  const seed = values.slice(0, period).reduce((acc, value) => acc + value, 0) / period;
  emaSeries.push(seed);

  for (let i = period; i < values.length; i += 1) {
    const previous = emaSeries[emaSeries.length - 1];
    const current = values[i] * smoothing + previous * (1 - smoothing);
    emaSeries.push(current);
  }

  return emaSeries;
}

export function calculateRsi(values: number[], period = 14): number | null {
  if (values.length <= period) {
    return null;
  }

  let gainSum = 0;
  let lossSum = 0;

  // Seed average gain/loss using the first RSI window.
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) {
      gainSum += delta;
    } else {
      lossSum += Math.abs(delta);
    }
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;

  // Continue with Wilder smoothing for remaining candles.
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;

    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

export type MacdResult = {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
};

export function calculateMacd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  if (values.length < slowPeriod + signalPeriod) {
    return { macd: null, signal: null, histogram: null };
  }

  const fastEma = calculateEmaSeries(values, fastPeriod);
  const slowEma = calculateEmaSeries(values, slowPeriod);
  if (fastEma.length === 0 || slowEma.length === 0) {
    return { macd: null, signal: null, histogram: null };
  }

  // Align the series so each MACD point compares EMA values from the same candle.
  const alignmentOffset = slowPeriod - fastPeriod;
  const alignedFast = fastEma.slice(alignmentOffset);
  const macdSeries = slowEma.map((slowValue, index) => alignedFast[index] - slowValue);
  const signalSeries = calculateEmaSeries(macdSeries, signalPeriod);

  if (signalSeries.length === 0) {
    return { macd: null, signal: null, histogram: null };
  }

  const macd = macdSeries[macdSeries.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return {
    macd,
    signal,
    histogram: macd - signal,
  };
}

export type BollingerBandsResult = {
  upper: number | null;
  middle: number | null;
  lower: number | null;
};

export function calculateBollingerBands(
  values: number[],
  period = 20,
  standardDeviationMultiplier = 2,
): BollingerBandsResult {
  if (values.length < period) {
    return { upper: null, middle: null, lower: null };
  }

  const window = values.slice(-period);
  const middle =
    window.reduce((accumulator, current) => accumulator + current, 0) / period;
  const variance =
    window.reduce((accumulator, current) => {
      const distance = current - middle;
      return accumulator + distance * distance;
    }, 0) / period;

  const deviation = Math.sqrt(variance);
  return {
    upper: middle + standardDeviationMultiplier * deviation,
    middle,
    lower: middle - standardDeviationMultiplier * deviation,
  };
}
