declare module 'maplibre-gl';

declare module '@deck.gl/core' {
  export interface PickingInfo<D = any> {
    x: number;
    y: number;
    object?: D;
    index?: number;
    coordinate?: number[];
  }
}

declare module '@deck.gl/mapbox' {
  export class MapboxOverlay {
    constructor(props: Record<string, any>);
    setProps(props: Record<string, any>): void;
    onAdd(map: any): HTMLElement;
    onRemove(): void;
  }
}

declare module '@deck.gl/layers' {
  import type { PickingInfo } from '@deck.gl/core';

  export class ScatterplotLayer<DataT = any> {
    constructor(props: Record<string, any>);
  }

  export interface PolygonLayerProps<DataT = any> {
    id: string;
    data: DataT[];
    pickable?: boolean;
    wireframe?: boolean;
    filled?: boolean;
    stroked?: boolean;
    extruded?: boolean;
    getPolygon?: (d: DataT) => [number, number][];
    getFillColor?: (d: DataT) => [number, number, number, number] | [number, number, number];
    getLineColor?: (d: DataT) => [number, number, number, number] | [number, number, number];
    lineWidthMinPixels?: number;
    getElevation?: (d: DataT) => number;
    elevationScale?: number;
    updateTriggers?: Record<string, any>;
    onHover?: (info: PickingInfo<DataT>) => void;
    onClick?: (info: PickingInfo<DataT>) => void;
  }

  export class PolygonLayer<DataT = any> {
    constructor(props: PolygonLayerProps<DataT>);
  }

  export interface TextLayerProps<DataT = any> {
    id: string;
    data: DataT[];
    pickable?: boolean;
    getPosition?: (d: DataT) => [number, number, number] | [number, number];
    getText?: (d: DataT) => string;
    getSize?: number | ((d: DataT) => number);
    getColor?: [number, number, number, number] | ((d: DataT) => [number, number, number, number]);
    getAngle?: number;
    getTextAnchor?: 'start' | 'middle' | 'end';
    getAlignmentBaseline?: 'top' | 'center' | 'bottom';
    fontFamily?: string;
    fontWeight?: string | number;
    background?: boolean;
    getBackgroundColor?: [number, number, number, number] | ((d: DataT) => [number, number, number, number]);
    backgroundPadding?: [number, number] | [number, number, number, number];
    billboard?: boolean;
    sizeScale?: number;
    sizeUnits?: 'pixels' | 'meters' | 'common';
    updateTriggers?: Record<string, any>;
  }

  export class TextLayer<DataT = any> {
    constructor(props: TextLayerProps<DataT>);
  }
}

declare module '@deck.gl/geo-layers' {
  import type { PickingInfo } from '@deck.gl/core';

  export interface H3HexagonLayerProps<DataT = any> {
    id: string;
    data: DataT[];
    pickable?: boolean;
    wireframe?: boolean;
    filled?: boolean;
    extruded?: boolean;
    getHexagon?: (d: DataT) => string;
    getFillColor?: (d: DataT) => [number, number, number, number] | [number, number, number];
    getLineColor?: (d: DataT) => [number, number, number, number] | [number, number, number];
    lineWidthMinPixels?: number;
    getElevation?: (d: DataT) => number;
    elevationScale?: number;
    updateTriggers?: Record<string, any>;
    onHover?: (info: PickingInfo<DataT>) => void;
    onClick?: (info: PickingInfo<DataT>) => void;
  }

  export class H3HexagonLayer<DataT = any> {
    constructor(props: H3HexagonLayerProps<DataT>);
  }
}

