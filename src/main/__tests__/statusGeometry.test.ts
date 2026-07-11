import { describe, it, expect } from 'vitest';
import {
  computeStatusRect,
  estimateStatusWidth,
  STATUS_BUBBLE_HEIGHT,
} from '../statusGeometry';

const WIN = { width: 1200, height: 800 };

describe('estimateStatusWidth', () => {
  it('clamps tiny texts to the minimum width', () => {
    expect(estimateStatusWidth('a', 600)).toBe(60);
  });

  it('grows with text length but never exceeds maxWidth', () => {
    const short = estimateStatusWidth('https://example.com', 600);
    const long = estimateStatusWidth('https://example.com/' + 'x'.repeat(200), 600);
    expect(long).toBeGreaterThan(short);
    expect(long).toBe(600);
  });
});

describe('computeStatusRect', () => {
  it('sits bottom-left when the cursor is far away', () => {
    const { bounds, side } = computeStatusRect(WIN, 300, { x: 600, y: 100 });
    expect(side).toBe('left');
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(WIN.height - STATUS_BUBBLE_HEIGHT);
    expect(bounds.width).toBe(300);
    expect(bounds.height).toBe(STATUS_BUBBLE_HEIGHT);
  });

  it('sits bottom-left when the cursor position is unknown', () => {
    expect(computeStatusRect(WIN, 300, null).side).toBe('left');
  });

  it('dodges to bottom-right when the cursor hovers the bottom-left corner', () => {
    const { bounds, side } = computeStatusRect(WIN, 300, { x: 50, y: WIN.height - 10 });
    expect(side).toBe('right');
    expect(bounds.x).toBe(WIN.width - 300);
    expect(bounds.y).toBe(WIN.height - STATUS_BUBBLE_HEIGHT);
  });

  it('stays left when the window is too narrow to dodge', () => {
    const narrow = { width: 200, height: 800 };
    // Bubble takes half the width; the cursor overlaps both candidate spots.
    const { side } = computeStatusRect(narrow, 400, { x: 100, y: 790 });
    expect(side).toBe('left');
  });

  it('caps the bubble at half the window width', () => {
    const { bounds } = computeStatusRect(WIN, 5000, null);
    expect(bounds.width).toBe(Math.floor(WIN.width * 0.5));
  });
});
