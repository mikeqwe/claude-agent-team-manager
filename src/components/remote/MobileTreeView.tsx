import { useState, useMemo, useCallback, useRef } from "react";
import type { RemoteNode } from "@/types/remote";

// ---------------------------------------------------------------------------
// Color Constants (matching desktop OrgNode.tsx)
// ---------------------------------------------------------------------------

const KIND_COLORS: Record<string, string> = {
  agent: "#f0883e",
  skill: "#3fb950",
  settings: "#6e7681",
  human: "#d29922",
  context: "#8b5cf6",
  group: "#4a9eff",
  pipeline: "#d946ef",
  note: "#d29922",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MobileTreeViewProps {
  nodes: RemoteNode[];
  onNodeSelect?: (node: RemoteNode) => void;
  onDeploy?: (teamId: string) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildChildMap(nodes: RemoteNode[]): Map<string, RemoteNode[]> {
  const map = new Map<string, RemoteNode[]>();
  for (const node of nodes) {
    const parentId = node.parentId ?? "root";
    const existing = map.get(parentId);
    if (existing) {
      existing.push(node);
    } else {
      map.set(parentId, [node]);
    }
  }
  return map;
}

function buildNodeMap(nodes: RemoteNode[]): Map<string, RemoteNode> {
  const map = new Map<string, RemoteNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}

function getAncestors(nodeId: string, nodeMap: Map<string, RemoteNode>): RemoteNode[] {
  const ancestors: RemoteNode[] = [];
  let current = nodeMap.get(nodeId);
  while (current?.parentId) {
    const parent = nodeMap.get(current.parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent;
  }
  return ancestors;
}

function getNodeLabel(node: RemoteNode, nodeMap: Map<string, RemoteNode>): string {
  const isGroup = node.kind === "group";
  const isPipeline = node.kind === "pipeline";
  const isRoot = node.kind === "human";
  if (isRoot) return "YOU";
  if (isPipeline) return "PROJECT MGR";

  if (isGroup) {
    const parent = node.parentId ? nodeMap.get(node.parentId) : null;
    const parentIsGroup = parent?.kind === "group";
    const grandparent = parent?.parentId ? nodeMap.get(parent.parentId) : null;
    const parentIsMember = parentIsGroup && grandparent?.kind === "group";

    if (parent?.kind === "agent" || parentIsMember) return "SUB-AGENT";
    if (parentIsGroup) return "AGENT";
    return "TEAM";
  }

  return node.kind.toUpperCase();
}

function getNodeColor(node: RemoteNode, nodeMap: Map<string, RemoteNode>): string {
  if (node.kind === "pipeline") return "#d946ef";
  if (node.kind === "group") {
    const parent = node.parentId ? nodeMap.get(node.parentId) : null;
    const parentIsGroup = parent?.kind === "group";
    const grandparent = parent?.parentId ? nodeMap.get(parent.parentId) : null;
    const parentIsMember = parentIsGroup && grandparent?.kind === "group";

    if (parent?.kind === "agent" || parentIsMember) return "#a5d6ff";
    if (parentIsGroup) return "#f0883e";
    return "#4a9eff";
  }
  return KIND_COLORS[node.kind] ?? "#4a9eff";
}

function matchesSearch(node: RemoteNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    node.name.toLowerCase().includes(q) ||
    node.kind.toLowerCase().includes(q) ||
    (node.promptBody ?? "").toLowerCase().includes(q)
  );
}

function hasMatchingDescendant(
  nodeId: string,
  childMap: Map<string, RemoteNode[]>,
  query: string,
): boolean {
  const children = childMap.get(nodeId);
  if (!children) return false;
  for (const child of children) {
    if (matchesSearch(child, query)) return true;
    if (hasMatchingDescendant(child.id, childMap, query)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pull-to-Refresh Hook
// ---------------------------------------------------------------------------

function usePullToRefresh(
  onRefresh?: () => void,
  isRefreshing?: boolean,
): {
  pullProgress: number;
  isPulling: boolean;
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
} {
  const [pullProgress, setPullProgress] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const startY = useRef(0);
  const scrollRef = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const target = e.currentTarget;
    if (target.scrollTop <= 0) {
      startY.current = e.touches[0].clientY;
      scrollRef.current = true;
    } else {
      scrollRef.current = false;
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!scrollRef.current || isRefreshing) return;
    const diff = e.touches[0].clientY - startY.current;
    if (diff > 0) {
      const progress = Math.min(diff / 120, 1);
      setPullProgress(progress);
      setIsPulling(progress >= 1);
    }
  }, [isRefreshing]);

  const onTouchEnd = useCallback(() => {
    if (isPulling && onRefresh && !isRefreshing) {
      onRefresh();
    }
    setPullProgress(0);
    setIsPulling(false);
    scrollRef.current = false;
  }, [isPulling, onRefresh, isRefreshing]);

  return {
    pullProgress,
    isPulling,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}

// ---------------------------------------------------------------------------
// Sub-Components
// ---------------------------------------------------------------------------

function Breadcrumbs({
  ancestors,
  nodeMap,
  onNavigate,
}: {
  ancestors: RemoteNode[];
  nodeMap: Map<string, RemoteNode>;
  onNavigate: (nodeId: string | null) => void;
}) {
  if (ancestors.length === 0) return null;

  return (
    <div style={styles.breadcrumbContainer}>
      <button
        onClick={() => onNavigate(null)}
        style={styles.breadcrumbButton}
      >
        Root
      </button>
      {ancestors.map((ancestor) => (
        <span key={ancestor.id} style={styles.breadcrumbItem}>
          <span style={styles.breadcrumbSeparator}>/</span>
          <button
            onClick={() => onNavigate(ancestor.id)}
            style={{
              ...styles.breadcrumbButton,
              color: getNodeColor(ancestor, nodeMap),
            }}
          >
            {ancestor.name}
          </button>
        </span>
      ))}
    </div>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={styles.searchContainer}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#6e7681"
        strokeWidth="2"
        style={{ flexShrink: 0 }}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search nodes..."
        style={styles.searchInput}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          style={styles.searchClear}
        >
          x
        </button>
      )}
    </div>
  );
}

function FilterChips({
  activeFilter,
  onFilter,
}: {
  activeFilter: string | null;
  onFilter: (kind: string | null) => void;
}) {
  const kinds = ["group", "agent", "skill", "pipeline", "settings"] as const;

  return (
    <div style={styles.filterContainer}>
      <button
        onClick={() => onFilter(null)}
        style={{
          ...styles.filterChip,
          background: activeFilter === null ? "rgba(74, 158, 255, 0.2)" : "transparent",
          borderColor: activeFilter === null ? "#4a9eff" : "#30363d",
          color: activeFilter === null ? "#4a9eff" : "#8b949e",
        }}
      >
        All
      </button>
      {kinds.map((kind) => {
        const color = KIND_COLORS[kind];
        const active = activeFilter === kind;
        return (
          <button
            key={kind}
            onClick={() => onFilter(active ? null : kind)}
            style={{
              ...styles.filterChip,
              background: active ? `${color}20` : "transparent",
              borderColor: active ? color : "#30363d",
              color: active ? color : "#8b949e",
            }}
          >
            {kind === "group" ? "Team" : kind === "pipeline" ? "PM" : kind.charAt(0).toUpperCase() + kind.slice(1)}
          </button>
        );
      })}
    </div>
  );
}

function NodeCard({
  node,
  nodeMap,
  childMap,
  expanded,
  onToggle,
  onSelect,
  onDeploy,
  depth,
  searchQuery,
  filterKind,
}: {
  node: RemoteNode;
  nodeMap: Map<string, RemoteNode>;
  childMap: Map<string, RemoteNode[]>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (node: RemoteNode) => void;
  onDeploy?: (teamId: string) => void;
  depth: number;
  searchQuery: string;
  filterKind: string | null;
}) {
  const color = getNodeColor(node, nodeMap);
  const label = getNodeLabel(node, nodeMap);
  const children = childMap.get(node.id) ?? [];
  const isExpanded = expanded.has(node.id);
  const hasChildren = children.length > 0;
  const isGroup = node.kind === "group";
  const isPipeline = node.kind === "pipeline";
  const canExpand = hasChildren && (isGroup || isPipeline || node.kind === "human");

  const description = isGroup || isPipeline
    ? node.promptBody
    : ((node.config as { description?: string } | null)?.description ?? "");

  // Filter visible children
  const visibleChildren = children.filter((child) => {
    if (child.kind === "note") return false;
    if (filterKind && child.kind !== filterKind && child.kind !== "group" && child.kind !== "pipeline") {
      return hasMatchingDescendant(child.id, childMap, searchQuery);
    }
    if (searchQuery) {
      return matchesSearch(child, searchQuery) || hasMatchingDescendant(child.id, childMap, searchQuery);
    }
    return true;
  });

  // Touch handling for swipe actions
  const touchStartX = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const diff = e.touches[0].clientX - touchStartX.current;
    if (diff < -10) {
      setSwipeOffset(Math.max(diff, -100));
    } else {
      setSwipeOffset(0);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (swipeOffset < -60 && isGroup && onDeploy) {
      onDeploy(node.id);
    }
    setSwipeOffset(0);
  }, [swipeOffset, isGroup, onDeploy, node.id]);

  return (
    <div style={{ marginLeft: depth > 0 ? 8 : 0 }}>
      <div style={styles.nodeCardWrapper}>
        {/* Swipe action reveal (deploy button) */}
        {isGroup && onDeploy && (
          <div style={styles.swipeAction}>
            <span style={{ color: "#fff", fontSize: 12, fontWeight: 600 }}>Deploy</span>
          </div>
        )}

        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onClick={() => onSelect(node)}
          style={{
            ...styles.nodeCard,
            borderLeftColor: color,
            transform: `translateX(${swipeOffset}px)`,
            transition: swipeOffset === 0 ? "transform 0.2s ease" : "none",
          }}
        >
          {/* Expand/collapse toggle */}
          {canExpand && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggle(node.id);
              }}
              style={{
                ...styles.expandButton,
                color,
              }}
            >
              {isExpanded ? "\u25BE" : "\u25B8"}
            </button>
          )}

          <div style={{ flex: 1, minWidth: 0, marginLeft: canExpand ? 0 : 20 }}>
            {/* Top row: name + badge */}
            <div style={styles.nodeCardHeader}>
              <span style={styles.nodeName}>{node.name}</span>
              <span
                style={{
                  ...styles.kindBadge,
                  background: color,
                }}
              >
                {label}
              </span>
            </div>

            {/* Description */}
            {description && (
              <div style={styles.nodeDescription}>{description}</div>
            )}

            {/* Meta info row */}
            <div style={styles.nodeMeta}>
              {isGroup && (
                <span style={{ color }}>
                  {visibleChildren.length} {label === "TEAM"
                    ? (visibleChildren.length === 1 ? "agent" : "agents")
                    : (visibleChildren.length === 1 ? "sub-agent" : "sub-agents")}
                </span>
              )}
              {isPipeline && (
                <span style={{ color }}>
                  {node.pipelineSteps.length} {node.pipelineSteps.length === 1 ? "step" : "steps"}
                </span>
              )}
              {node.assignedSkills.length > 0 && (
                <span style={styles.skillCount}>
                  {node.assignedSkills.length} {node.assignedSkills.length === 1 ? "skill" : "skills"}
                </span>
              )}
              {node.validationErrors.length > 0 && (
                <span style={styles.errorDot} title={node.validationErrors.join(", ")} />
              )}
            </div>
          </div>

          {/* Chevron for navigation */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#30363d"
            strokeWidth="2"
            style={{ flexShrink: 0 }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>

      {/* Expanded children */}
      {isExpanded && visibleChildren.length > 0 && (
        <div style={styles.childrenContainer}>
          <div style={{ ...styles.childLine, borderColor: `${color}30` }} />
          <div style={{ flex: 1 }}>
            {visibleChildren.map((child) => (
              <NodeCard
                key={child.id}
                node={child}
                nodeMap={nodeMap}
                childMap={childMap}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
                onDeploy={onDeploy}
                depth={depth + 1}
                searchQuery={searchQuery}
                filterKind={filterKind}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function MobileTreeView({
  nodes,
  onNodeSelect,
  onDeploy,
  onRefresh,
  isRefreshing,
}: MobileTreeViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["root"]));
  const [searchQuery, setSearchQuery] = useState("");
  const [filterKind, setFilterKind] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const nodeMap = useMemo(() => buildNodeMap(nodes), [nodes]);
  const childMap = useMemo(() => buildChildMap(nodes), [nodes]);

  const { pullProgress, handlers: pullHandlers } = usePullToRefresh(onRefresh, isRefreshing);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleNodeSelect = useCallback((node: RemoteNode) => {
    onNodeSelect?.(node);
  }, [onNodeSelect]);

  const navigateTo = useCallback((nodeId: string | null) => {
    setFocusedNodeId(nodeId);
    if (nodeId) {
      // Auto-expand the target and its ancestors
      const ancestors = getAncestors(nodeId, nodeMap);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(nodeId);
        for (const a of ancestors) next.add(a.id);
        return next;
      });
    }
  }, [nodeMap]);

  // Determine root nodes to display
  const rootNodes = useMemo(() => {
    if (focusedNodeId) {
      return childMap.get(focusedNodeId) ?? [];
    }
    // Show top-level nodes (children of root, or the root node itself)
    const rootChildren = childMap.get("root") ?? [];
    const rootNode = nodeMap.get("root");
    if (rootNode && rootChildren.length === 0) return [rootNode];
    return rootChildren;
  }, [focusedNodeId, childMap, nodeMap]);

  // Filter root nodes by search/filter
  const visibleRootNodes = useMemo(() => {
    return rootNodes.filter((node) => {
      if (node.kind === "note") return false;
      if (filterKind && node.kind !== filterKind && node.kind !== "group" && node.kind !== "pipeline" && node.kind !== "human") {
        return hasMatchingDescendant(node.id, childMap, searchQuery);
      }
      if (searchQuery) {
        return matchesSearch(node, searchQuery) || hasMatchingDescendant(node.id, childMap, searchQuery);
      }
      return true;
    });
  }, [rootNodes, searchQuery, filterKind, childMap]);

  // Breadcrumb ancestors for focused node
  const focusedAncestors = useMemo(() => {
    if (!focusedNodeId) return [];
    const focusedNode = nodeMap.get(focusedNodeId);
    if (!focusedNode) return [];
    return [...getAncestors(focusedNodeId, nodeMap), focusedNode];
  }, [focusedNodeId, nodeMap]);

  // Summary stats
  const stats = useMemo(() => {
    let teams = 0;
    let agents = 0;
    let skills = 0;
    let pipelines = 0;
    for (const node of nodes) {
      if (node.kind === "group") {
        const parent = node.parentId ? nodeMap.get(node.parentId) : null;
        if (parent?.kind === "group") agents++;
        else teams++;
      } else if (node.kind === "agent") agents++;
      else if (node.kind === "skill") skills++;
      else if (node.kind === "pipeline") pipelines++;
    }
    return { teams, agents, skills, pipelines };
  }, [nodes, nodeMap]);

  return (
    <div
      style={styles.container}
      {...pullHandlers}
    >
      {/* Pull-to-refresh indicator */}
      {(pullProgress > 0 || isRefreshing) && (
        <div
          style={{
            ...styles.pullIndicator,
            height: isRefreshing ? 40 : pullProgress * 40,
            opacity: isRefreshing ? 1 : pullProgress,
          }}
        >
          <div
            style={{
              ...styles.pullSpinner,
              transform: isRefreshing ? "rotate(360deg)" : `rotate(${pullProgress * 360}deg)`,
              animation: isRefreshing ? "spin 0.8s linear infinite" : "none",
            }}
          />
          <span style={{ fontSize: 12, color: "#8b949e" }}>
            {isRefreshing ? "Refreshing..." : "Release to refresh"}
          </span>
        </div>
      )}

      {/* Header stats bar */}
      <div style={styles.statsBar}>
        <div style={styles.statItem}>
          <span style={{ ...styles.statDot, background: "#4a9eff" }} />
          <span style={styles.statValue}>{stats.teams}</span>
          <span style={styles.statLabel}>Teams</span>
        </div>
        <div style={styles.statItem}>
          <span style={{ ...styles.statDot, background: "#f0883e" }} />
          <span style={styles.statValue}>{stats.agents}</span>
          <span style={styles.statLabel}>Agents</span>
        </div>
        <div style={styles.statItem}>
          <span style={{ ...styles.statDot, background: "#3fb950" }} />
          <span style={styles.statValue}>{stats.skills}</span>
          <span style={styles.statLabel}>Skills</span>
        </div>
        {stats.pipelines > 0 && (
          <div style={styles.statItem}>
            <span style={{ ...styles.statDot, background: "#d946ef" }} />
            <span style={styles.statValue}>{stats.pipelines}</span>
            <span style={styles.statLabel}>PMs</span>
          </div>
        )}
      </div>

      {/* Search & Filter */}
      <SearchInput value={searchQuery} onChange={setSearchQuery} />
      <FilterChips activeFilter={filterKind} onFilter={setFilterKind} />

      {/* Breadcrumbs */}
      <Breadcrumbs
        ancestors={focusedAncestors}
        nodeMap={nodeMap}
        onNavigate={navigateTo}
      />

      {/* Node list */}
      <div style={styles.nodeList}>
        {visibleRootNodes.length === 0 && (
          <div style={styles.emptyState}>
            {searchQuery || filterKind
              ? "No matching nodes found"
              : "No nodes in this project"}
          </div>
        )}

        {/* Show the focused node as a header card */}
        {focusedNodeId && nodeMap.has(focusedNodeId) && (
          <div
            style={styles.focusedHeader}
            onClick={() => navigateTo(nodeMap.get(focusedNodeId)?.parentId ?? null)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#8b949e"
              strokeWidth="2"
              style={{ flexShrink: 0 }}
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span style={{ color: getNodeColor(nodeMap.get(focusedNodeId)!, nodeMap), fontWeight: 600 }}>
              {nodeMap.get(focusedNodeId)!.name}
            </span>
          </div>
        )}

        {visibleRootNodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            nodeMap={nodeMap}
            childMap={childMap}
            expanded={expanded}
            onToggle={toggleExpand}
            onSelect={handleNodeSelect}
            onDeploy={onDeploy}
            depth={0}
            searchQuery={searchQuery}
            filterKind={filterKind}
          />
        ))}
      </div>

      {/* Spin animation for pull-to-refresh */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Styles (matching ATM dark theme)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#0d1117",
    color: "#e6edf3",
    overflow: "hidden",
    WebkitOverflowScrolling: "touch",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },

  pullIndicator: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    overflow: "hidden",
    flexShrink: 0,
  },

  pullSpinner: {
    width: 20,
    height: 20,
    border: "2px solid #30363d",
    borderTopColor: "#4a9eff",
    borderRadius: "50%",
    transition: "transform 0.1s linear",
  },

  statsBar: {
    display: "flex",
    justifyContent: "space-around",
    padding: "12px 16px",
    borderBottom: "1px solid #21262d",
    flexShrink: 0,
  },

  statItem: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },

  statDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },

  statValue: {
    fontSize: 14,
    fontWeight: 700,
    color: "#e6edf3",
  },

  statLabel: {
    fontSize: 11,
    color: "#8b949e",
  },

  searchContainer: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "8px 12px",
    padding: "8px 12px",
    background: "#151b23",
    borderRadius: 8,
    border: "1px solid #21262d",
    flexShrink: 0,
  },

  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "#e6edf3",
    fontSize: 14,
    fontFamily: "inherit",
  },

  searchClear: {
    background: "none",
    border: "none",
    color: "#6e7681",
    fontSize: 16,
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: 1,
  },

  filterContainer: {
    display: "flex",
    gap: 6,
    padding: "0 12px 8px",
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    flexShrink: 0,
  },

  filterChip: {
    padding: "4px 10px",
    borderRadius: 12,
    border: "1px solid #30363d",
    background: "transparent",
    color: "#8b949e",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontFamily: "inherit",
  },

  breadcrumbContainer: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "4px 12px 8px",
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    flexShrink: 0,
    fontSize: 12,
  },

  breadcrumbButton: {
    background: "none",
    border: "none",
    color: "#8b949e",
    fontSize: 12,
    cursor: "pointer",
    padding: "2px 4px",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  },

  breadcrumbItem: {
    display: "flex",
    alignItems: "center",
  },

  breadcrumbSeparator: {
    color: "#30363d",
    margin: "0 2px",
  },

  nodeList: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "0 12px 80px",
    WebkitOverflowScrolling: "touch",
  },

  nodeCardWrapper: {
    position: "relative",
    overflow: "hidden",
    borderRadius: 8,
    marginBottom: 6,
  },

  swipeAction: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 80,
    background: "#4a9eff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },

  nodeCard: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    background: "#151b23",
    borderRadius: 8,
    borderLeft: "3px solid #4a9eff",
    cursor: "pointer",
    position: "relative",
    zIndex: 1,
    touchAction: "pan-y",
    WebkitTapHighlightColor: "transparent",
  },

  expandButton: {
    background: "none",
    border: "none",
    fontSize: 16,
    cursor: "pointer",
    padding: "4px",
    lineHeight: 1,
    flexShrink: 0,
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "inherit",
  },

  nodeCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },

  nodeName: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e6edf3",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
  },

  kindBadge: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#fff",
    padding: "1px 6px",
    borderRadius: 10,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },

  nodeDescription: {
    fontSize: 12,
    color: "#8b949e",
    lineHeight: "1.3",
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
  },

  nodeMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
    fontSize: 11,
  },

  skillCount: {
    color: "#3fb950",
    fontSize: 11,
  },

  errorDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#f85149",
    flexShrink: 0,
  },

  childrenContainer: {
    display: "flex",
    paddingLeft: 12,
  },

  childLine: {
    width: 0,
    borderLeft: "1px dashed #30363d",
    marginRight: 8,
    flexShrink: 0,
  },

  emptyState: {
    textAlign: "center",
    padding: "48px 24px",
    color: "#6e7681",
    fontSize: 14,
  },

  focusedHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 4px 12px",
    cursor: "pointer",
    fontSize: 16,
  },
};
