"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type PeriodOption = "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "max";
type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type OverlayState = {
  volume: boolean;
  macd: boolean;
  ma20: boolean;
  ma50: boolean;
  ma200: boolean;
  bbUpper: boolean;
  bbLower: boolean;
};

const PERIOD_OPTIONS: Array<{ value: PeriodOption; label: string }> = [
  { value: "1mo", label: "1M" },
  { value: "3mo", label: "3M" },
  { value: "6mo", label: "6M" },
  { value: "1y", label: "1Y" },
  { value: "2y", label: "2Y" },
  { value: "5y", label: "5Y" },
  { value: "max", label: "Max" },
];
const OVERLAY_OPTIONS: Array<{ key: keyof OverlayState; label: string }> = [
  { key: "volume", label: "Volume" },
  { key: "macd", label: "MACD" },
  { key: "ma20", label: "MA20" },
  { key: "ma50", label: "MA50" },
  { key: "ma200", label: "MA200" },
  { key: "bbUpper", label: "BB Upper" },
  { key: "bbLower", label: "BB Lower" },
];

function formatPrice(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatAxisPrice(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function formatVolumeCompact(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 })}B`;
  }
  if (absValue >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 })}M`;
  }
  if (absValue >= 1_000) {
    return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 0 })}K`;
  }
  return Math.round(value).toLocaleString();
}

function buildSmaSeries(candles: Candle[], period: number): Array<number | null> {
  return candles.map((_, index) => {
    if (index < period - 1) {
      return null;
    }
    const window = candles.slice(index - period + 1, index + 1);
    const sum = window.reduce((acc, candle) => acc + candle.close, 0);
    return sum / period;
  });
}

function buildBollingerBandSeries(
  candles: Candle[],
  period = 20,
  standardDeviationMultiplier = 2,
): { upper: Array<number | null>; lower: Array<number | null> } {
  const upper: Array<number | null> = [];
  const lower: Array<number | null> = [];

  candles.forEach((_, index) => {
    if (index < period - 1) {
      upper.push(null);
      lower.push(null);
      return;
    }

    const window = candles.slice(index - period + 1, index + 1);
    const mean = window.reduce((acc, candle) => acc + candle.close, 0) / period;
    const variance =
      window.reduce((acc, candle) => {
        const distance = candle.close - mean;
        return acc + distance * distance;
      }, 0) / period;
    const deviation = Math.sqrt(variance);

    upper.push(mean + standardDeviationMultiplier * deviation);
    lower.push(mean - standardDeviationMultiplier * deviation);
  });

  return { upper, lower };
}

function buildEmaSeries(values: number[], period: number): Array<number | null> {
  const ema: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) {
    return ema;
  }

  const seed = values.slice(0, period).reduce((acc, value) => acc + value, 0) / period;
  ema[period - 1] = seed;
  const smoothing = 2 / (period + 1);

  for (let index = period; index < values.length; index += 1) {
    const previous = ema[index - 1] ?? seed;
    ema[index] = values[index] * smoothing + previous * (1 - smoothing);
  }

  return ema;
}

function buildEmaSeriesFromNullable(
  values: Array<number | null>,
  period: number,
): Array<number | null> {
  const firstIndex = values.findIndex((value) => value !== null);
  if (firstIndex === -1) {
    return new Array(values.length).fill(null);
  }

  const numericTail = values.slice(firstIndex).map((value) => value as number);
  const emaTail = buildEmaSeries(numericTail, period);
  return [
    ...new Array(firstIndex).fill(null),
    ...emaTail,
  ] as Array<number | null>;
}

function buildMacdSeries(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  const fast = buildEmaSeries(closes, 12);
  const slow = buildEmaSeries(closes, 26);
  const macd = closes.map((_, index) => {
    if (fast[index] === null || slow[index] === null) {
      return null;
    }
    return (fast[index] as number) - (slow[index] as number);
  });
  const signal = buildEmaSeriesFromNullable(macd, 9);
  const histogram = macd.map((value, index) => {
    if (value === null || signal[index] === null) {
      return null;
    }
    return value - (signal[index] as number);
  });

  return { macd, signal, histogram };
}

function buildLinePath(
  values: Array<number | null>,
  xAt: (index: number) => number,
  yAt: (value: number) => number,
): string {
  let path = "";
  let hasActiveSegment = false;

  values.forEach((value, index) => {
    if (value === null) {
      hasActiveSegment = false;
      return;
    }

    const x = xAt(index);
    const y = yAt(value);
    if (!hasActiveSegment) {
      path += `M ${x} ${y}`;
      hasActiveSegment = true;
    } else {
      path += ` L ${x} ${y}`;
    }
  });

  return path;
}

function buildMonthTicks(candles: Candle[], xAt: (index: number) => number) {
  const rawTicks: Array<{ x: number; label: string }> = [];
  let previousMonthKey = "";

  candles.forEach((candle, index) => {
    const date = new Date(candle.time);
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    if (monthKey !== previousMonthKey) {
      // Use the first available trading day of each month.
      rawTicks.push({
        x: xAt(index),
        label: date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
      });
      previousMonthKey = monthKey;
    }
  });

  // Prevent overlapping labels when very dense periods are selected.
  const minSpacingPx = 56;
  const filteredTicks: Array<{ x: number; label: string }> = [];
  rawTicks.forEach((tick) => {
    const previous = filteredTicks[filteredTicks.length - 1];
    if (!previous || tick.x - previous.x >= minSpacingPx) {
      filteredTicks.push(tick);
    }
  });

  return filteredTicks;
}

function CandlestickChart({
  candles,
  overlays,
}: {
  candles: Candle[];
  overlays: OverlayState;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (candles.length === 0) {
    return <p className="muted-text">No chart data available for this period.</p>;
  }

  const width = Math.max(840, candles.length * 10);
  const height = 560;
  const padding = { top: 20, right: 16, bottom: 26, left: 46 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const panelGap = 12;
  const lowerPanelHeight = 92;
  const enabledLowerPanels = (overlays.volume ? 1 : 0) + (overlays.macd ? 1 : 0);
  const totalLowerHeight =
    enabledLowerPanels === 0
      ? 0
      : enabledLowerPanels * lowerPanelHeight + (enabledLowerPanels - 1) * panelGap;
  const pricePanelHeight = Math.max(180, innerHeight - totalLowerHeight);
  const pricePanelBottom = padding.top + pricePanelHeight;
  let nextLowerPanelTop = pricePanelBottom + (enabledLowerPanels > 0 ? panelGap : 0);
  const volumeTop = overlays.volume ? nextLowerPanelTop : null;
  const volumeBottom = overlays.volume && volumeTop !== null ? volumeTop + lowerPanelHeight : null;
  if (overlays.volume && volumeBottom !== null) {
    nextLowerPanelTop = volumeBottom + (overlays.macd ? panelGap : 0);
  }
  const macdTop = overlays.macd ? nextLowerPanelTop : null;
  const macdBottom = overlays.macd && macdTop !== null ? macdTop + lowerPanelHeight : null;
  const chartBottom = macdBottom ?? volumeBottom ?? pricePanelBottom;
  const step = innerWidth / candles.length;
  const bodyWidth = Math.max(3, Math.min(8, step * 0.65));

  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const pricePadding = (maxPrice - minPrice || 1) * 0.05;
  const axisIncrement = 0.5;
  const topPrice = Math.ceil((maxPrice + pricePadding) / axisIncrement) * axisIncrement;
  const bottomPrice = Math.floor((minPrice - pricePadding) / axisIncrement) * axisIncrement;

  const yForPrice = (price: number) => {
    const ratio = (topPrice - price) / (topPrice - bottomPrice || 1);
    return padding.top + ratio * pricePanelHeight;
  };

  const volumes = candles.map((candle) => candle.volume);
  const maxVolume = Math.max(...volumes, 1);
  const yForVolume = (volume: number) => {
    if (volumeTop === null || volumeBottom === null) {
      return pricePanelBottom;
    }
    const ratio = volume / maxVolume;
    return volumeBottom - ratio * lowerPanelHeight;
  };
  const macdSeries = buildMacdSeries(candles);
  const macdValues = [
    ...macdSeries.macd.filter((value): value is number => value !== null),
    ...macdSeries.signal.filter((value): value is number => value !== null),
    ...macdSeries.histogram.filter((value): value is number => value !== null),
    0,
  ];
  const macdMax = Math.max(...macdValues);
  const macdMin = Math.min(...macdValues);
  const macdPadding = (macdMax - macdMin || 1) * 0.08;
  const macdTopValue = macdMax + macdPadding;
  const macdBottomValue = macdMin - macdPadding;
  const yForMacd = (value: number) => {
    if (macdTop === null || macdBottom === null) {
      return pricePanelBottom;
    }
    const ratio = (macdTopValue - value) / (macdTopValue - macdBottomValue || 1);
    return macdTop + ratio * lowerPanelHeight;
  };

  const ma20 = buildSmaSeries(candles, 20);
  const ma50 = buildSmaSeries(candles, 50);
  const ma200 = buildSmaSeries(candles, 200);
  const bollingerBands = buildBollingerBandSeries(candles, 20, 2);
  const xAt = (index: number) => padding.left + index * step + step / 2;
  const ma20Path = buildLinePath(ma20, xAt, yForPrice);
  const ma50Path = buildLinePath(ma50, xAt, yForPrice);
  const ma200Path = buildLinePath(ma200, xAt, yForPrice);
  const bbUpperPath = buildLinePath(bollingerBands.upper, xAt, yForPrice);
  const bbLowerPath = buildLinePath(bollingerBands.lower, xAt, yForPrice);

  const volumeGridSteps = 3;
  const verticalGridSteps = Math.min(8, Math.max(4, Math.floor(candles.length / 20)));
  const horizontalGridSteps = 20;
  const priceTicks = Array.from({ length: horizontalGridSteps + 1 }).map((_, index) => {
    const ratio = index / horizontalGridSteps;
    const value = topPrice - (topPrice - bottomPrice) * ratio;
    const y = padding.top + pricePanelHeight * ratio;
    return { value, y };
  });
  const monthTicks = buildMonthTicks(candles, xAt);
  const volumeTicks = Array.from({ length: volumeGridSteps + 1 }).map((_, index) => {
    const ratio = index / volumeGridSteps;
    const value = maxVolume * (1 - ratio);
    const y = (volumeTop ?? pricePanelBottom) + lowerPanelHeight * ratio;
    return { value, y };
  });
  const macdTicks = Array.from({ length: volumeGridSteps + 1 }).map((_, index) => {
    const ratio = index / volumeGridSteps;
    const value = macdTopValue - (macdTopValue - macdBottomValue) * ratio;
    const y = (macdTop ?? pricePanelBottom) + lowerPanelHeight * ratio;
    return { value, y };
  });
  const hoveredCandle = hoverIndex === null ? null : candles[hoverIndex];
  const hoveredBbUpper = hoverIndex === null ? null : bollingerBands.upper[hoverIndex];
  const hoveredBbLower = hoverIndex === null ? null : bollingerBands.lower[hoverIndex];
  const hoveredMacd = hoverIndex === null ? null : macdSeries.macd[hoverIndex];
  const hoveredMacdSignal = hoverIndex === null ? null : macdSeries.signal[hoverIndex];
  const hoveredMacdHistogram = hoverIndex === null ? null : macdSeries.histogram[hoverIndex];
  const crosshairX = hoverIndex === null ? null : xAt(hoverIndex);
  const crosshairCloseY =
    hoveredCandle && crosshairX !== null ? yForPrice(hoveredCandle.close) : null;
  const tooltipRows = hoveredCandle
    ? [
        new Date(hoveredCandle.time).toLocaleDateString(),
        `O: ${formatPrice(hoveredCandle.open)}`,
        `H: ${formatPrice(hoveredCandle.high)}`,
        `L: ${formatPrice(hoveredCandle.low)}`,
        `C: ${formatPrice(hoveredCandle.close)}`,
        `V: ${Math.round(hoveredCandle.volume).toLocaleString()}`,
        `BB U: ${hoveredBbUpper === null ? "—" : formatPrice(hoveredBbUpper)}`,
        `BB L: ${hoveredBbLower === null ? "—" : formatPrice(hoveredBbLower)}`,
        `MACD: ${hoveredMacd === null ? "—" : formatPrice(hoveredMacd)}`,
        `Signal: ${hoveredMacdSignal === null ? "—" : formatPrice(hoveredMacdSignal)}`,
        `Hist: ${hoveredMacdHistogram === null ? "—" : formatPrice(hoveredMacdHistogram)}`,
      ]
    : [];
  const longestRowLength = tooltipRows.reduce(
    (longest, row) => Math.max(longest, row.length),
    0,
  );
  const tooltipWidth = Math.max(174, longestRowLength * 7 + 20);
  const tooltipHeight = Math.max(56, tooltipRows.length * 16 + 10);
  const tooltipX =
    crosshairX === null
      ? padding.left
      : crosshairX + tooltipWidth + 14 <= width - padding.right
        ? crosshairX + 10
        : crosshairX - tooltipWidth - 10;
  const tooltipY = padding.top + 10;

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Candlestick chart"
        className="candle-svg"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - rect.left) * width) / rect.width;
          const relativeX = x - padding.left;
          if (relativeX < 0 || relativeX > innerWidth) {
            setHoverIndex(null);
            return;
          }
          const index = Math.min(candles.length - 1, Math.max(0, Math.round(relativeX / step)));
          setHoverIndex(index);
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {Array.from({ length: horizontalGridSteps + 1 }).map((_, index) => {
          const y = padding.top + (pricePanelHeight / horizontalGridSteps) * index;
          return (
            <line
              key={`grid-h-${index}`}
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              className="chart-grid-line"
            />
          );
        })}
        {overlays.volume
          ? Array.from({ length: volumeGridSteps + 1 }).map((_, index) => {
              const y = (volumeTop ?? pricePanelBottom) + (lowerPanelHeight / volumeGridSteps) * index;
              return (
                <line
                  key={`grid-vh-${index}`}
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  className="chart-grid-line"
                />
              );
            })
          : null}
        {overlays.macd
          ? Array.from({ length: volumeGridSteps + 1 }).map((_, index) => {
              const y = (macdTop ?? pricePanelBottom) + (lowerPanelHeight / volumeGridSteps) * index;
              return (
                <line
                  key={`grid-mh-${index}`}
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  className="chart-grid-line"
                />
              );
            })
          : null}
        {Array.from({ length: verticalGridSteps + 1 }).map((_, index) => {
          const x = padding.left + (innerWidth / verticalGridSteps) * index;
          return (
            <line
              key={`grid-v-${index}`}
              x1={x}
              y1={padding.top}
              x2={x}
              y2={chartBottom}
              className="chart-grid-line"
            />
          );
        })}

        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={pricePanelBottom}
          className="chart-axis"
        />
        <line
          x1={padding.left}
          y1={pricePanelBottom}
          x2={width - padding.right}
          y2={pricePanelBottom}
          className="chart-axis"
        />
        {overlays.volume ? (
          <>
            <line
              x1={padding.left}
              y1={volumeTop ?? pricePanelBottom}
              x2={padding.left}
              y2={volumeBottom}
              className="chart-axis"
            />
            <line
              x1={padding.left}
              y1={volumeBottom}
              x2={width - padding.right}
              y2={volumeBottom}
              className="chart-axis"
            />
          </>
        ) : null}
        {overlays.macd && macdTop !== null && macdBottom !== null ? (
          <>
            <line
              x1={padding.left}
              y1={macdTop}
              x2={padding.left}
              y2={macdBottom}
              className="chart-axis"
            />
            <line
              x1={padding.left}
              y1={macdBottom}
              x2={width - padding.right}
              y2={macdBottom}
              className="chart-axis"
            />
            <line
              x1={padding.left}
              y1={yForMacd(0)}
              x2={width - padding.right}
              y2={yForMacd(0)}
              className="chart-macd-zero"
            />
          </>
        ) : null}

        {candles.map((candle, index) => {
          const x = xAt(index);
          const openY = yForPrice(candle.open);
          const closeY = yForPrice(candle.close);
          const highY = yForPrice(candle.high);
          const lowY = yForPrice(candle.low);
          const bodyTop = Math.min(openY, closeY);
          const bodyHeight = Math.max(1, Math.abs(openY - closeY));
          const upCandle = candle.close >= candle.open;
          const volumeY = yForVolume(candle.volume);

          return (
            <g key={candle.time}>
              <line
                x1={x}
                y1={highY}
                x2={x}
                y2={lowY}
                className={upCandle ? "candle-up" : "candle-down"}
              />
              <rect
                x={x - bodyWidth / 2}
                y={bodyTop}
                width={bodyWidth}
                height={bodyHeight}
                className={upCandle ? "candle-up" : "candle-down"}
              />
              {overlays.volume ? (
                <rect
                  x={x - bodyWidth / 2}
                  y={volumeY}
                  width={bodyWidth}
                  height={Math.max(1, volumeBottom - volumeY)}
                  className={upCandle ? "volume-up" : "volume-down"}
                />
              ) : null}
            </g>
          );
        })}
        {overlays.macd
          ? candles.map((candle, index) => {
              const x = xAt(index);
              const value = macdSeries.histogram[index];
              if (value === null) {
                return null;
              }
              const zeroY = yForMacd(0);
              const valueY = yForMacd(value);
              const barY = Math.min(zeroY, valueY);
              const barHeight = Math.max(1, Math.abs(zeroY - valueY));
              return (
                <rect
                  key={`macd-bar-${candle.time}`}
                  x={x - bodyWidth / 2}
                  y={barY}
                  width={bodyWidth}
                  height={barHeight}
                  className={value >= 0 ? "macd-hist-up" : "macd-hist-down"}
                />
              );
            })
          : null}

        {overlays.ma20 && ma20Path ? <path d={ma20Path} className="ma20-line" /> : null}
        {overlays.ma50 && ma50Path ? <path d={ma50Path} className="ma50-line" /> : null}
        {overlays.ma200 && ma200Path ? <path d={ma200Path} className="ma200-line" /> : null}
        {overlays.bbUpper && bbUpperPath ? <path d={bbUpperPath} className="bb-upper-line" /> : null}
        {overlays.bbLower && bbLowerPath ? <path d={bbLowerPath} className="bb-lower-line" /> : null}
        {overlays.macd ? (
          <>
            <path d={buildLinePath(macdSeries.macd, xAt, yForMacd)} className="macd-line" />
            <path d={buildLinePath(macdSeries.signal, xAt, yForMacd)} className="macd-signal-line" />
          </>
        ) : null}
        {crosshairX !== null ? (
          <line
            x1={crosshairX}
            y1={padding.top}
            x2={crosshairX}
            y2={chartBottom}
            className="chart-crosshair-line"
          />
        ) : null}
        {crosshairX !== null && crosshairCloseY !== null ? (
          <circle cx={crosshairX} cy={crosshairCloseY} r={4} className="chart-crosshair-dot" />
        ) : null}
        {hoveredCandle ? (
          <g>
            <rect
              x={tooltipX}
              y={tooltipY}
              width={tooltipWidth}
              height={tooltipHeight}
              rx={8}
              className="chart-tooltip-bg"
            />
            {tooltipRows.map((row, index) => (
              <text
                key={`tooltip-row-${index}`}
                x={tooltipX + 8}
                y={tooltipY + 16 + index * 16}
                className="chart-tooltip-text"
              >
                {row}
              </text>
            ))}
          </g>
        ) : null}

        {priceTicks.map((tick, index) => (
          <text key={`price-tick-${index}`} x={6} y={tick.y + 4} className="chart-label">
            {formatAxisPrice(tick.value)}
          </text>
        ))}
        {overlays.volume
          ? volumeTicks.map((tick, index) => (
              <text key={`volume-tick-${index}`} x={6} y={tick.y + 4} className="chart-label">
                Vol {formatVolumeCompact(tick.value)}
              </text>
            ))
          : null}
        {overlays.macd
          ? macdTicks.map((tick, index) => (
              <text key={`macd-tick-${index}`} x={6} y={tick.y + 4} className="chart-label">
                M {formatAxisPrice(tick.value)}
              </text>
            ))
          : null}

        {monthTicks.map((tick, index) => (
          <text key={`month-tick-${index}`} x={tick.x - 18} y={height - 8} className="chart-label">
            {tick.label}
          </text>
        ))}
      </svg>
      <div className="chart-legend">
        {overlays.volume ? <span className="legend-item">Volume Bars</span> : null}
        {overlays.ma20 ? (
          <span className="legend-item">
            <span className="legend-dot legend-ma20" />
            MA20
          </span>
        ) : null}
        {overlays.ma50 ? (
          <span className="legend-item">
            <span className="legend-dot legend-ma50" />
            MA50
          </span>
        ) : null}
        {overlays.ma200 ? (
          <span className="legend-item">
            <span className="legend-dot legend-ma200" />
            MA200
          </span>
        ) : null}
        {overlays.bbUpper ? (
          <span className="legend-item">
            <span className="legend-dot legend-bb-upper" />
            BB Upper
          </span>
        ) : null}
        {overlays.bbLower ? (
          <span className="legend-item">
            <span className="legend-dot legend-bb-lower" />
            BB Lower
          </span>
        ) : null}
        {overlays.macd ? (
          <>
            <span className="legend-item">
              <span className="legend-dot legend-macd" />
              MACD
            </span>
            <span className="legend-item">
              <span className="legend-dot legend-macd-signal" />
              Signal
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function TickerChartPage() {
  const params = useParams<{ ticker: string }>();
  const ticker = useMemo(() => (params?.ticker ?? "").toUpperCase(), [params?.ticker]);
  const [period, setPeriod] = useState<PeriodOption>("6mo");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [overlays, setOverlays] = useState<OverlayState>({
    volume: true,
    macd: true,
    ma20: true,
    ma50: true,
    ma200: true,
    bbUpper: true,
    bbLower: true,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) {
      return;
    }

    let isCancelled = false;
    const load = async () => {
      try {
        setIsLoading(true);
        const response = await fetch(
          `/api/chart?symbol=${encodeURIComponent(ticker)}&period=${period}`,
          {
            cache: "no-store",
          },
        );
        const data = (await response.json()) as { candles?: Candle[]; error?: string };
        if (!response.ok) {
          throw new Error(data.error || "Failed to load chart.");
        }
        if (!isCancelled) {
          setCandles(Array.isArray(data.candles) ? data.candles : []);
          setError(null);
        }
      } catch (loadError) {
        if (!isCancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load chart.");
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    load();
    return () => {
      isCancelled = true;
    };
  }, [ticker, period]);

  return (
    <main className="dashboard-shell">
      <section className="panel chart-page-header">
        <div>
          <h1>{ticker} Candlestick Chart</h1>
          <p className="muted-text">Select a period to inspect price action over time.</p>
        </div>
        <Link href="/" className="secondary-button chart-back-link">
          Back To Dashboard
        </Link>
      </section>

      <section className="panel">
        <div className="overlay-switch-row">
          {OVERLAY_OPTIONS.map((item) => (
            <label key={item.key} className="toggle-switch">
              <input
                type="checkbox"
                checked={overlays[item.key]}
                onChange={() => {
                  // Toggle each overlay independently for flexible chart views.
                  setOverlays((prev) => ({
                    ...prev,
                    [item.key]: !prev[item.key],
                  }));
                }}
              />
              <span className="toggle-slider" />
              <span className="toggle-label">{item.label}</span>
            </label>
          ))}
        </div>
        <div className="chart-period-row">
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                period === option.value ? "primary-button small-button" : "secondary-button small-button"
              }
              onClick={() => setPeriod(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {isLoading ? <p className="muted-text">Loading chart...</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
        {!isLoading && !error ? <CandlestickChart candles={candles} overlays={overlays} /> : null}
      </section>
    </main>
  );
}
