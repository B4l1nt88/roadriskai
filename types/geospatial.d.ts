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
  export class ScatterplotLayer<DataT = any> {
    constructor(props: Record<string, any>);
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

