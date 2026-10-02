// The brain as the Aether Brain desktop app publishes it on its companion link (see docs/UNREAL.md):
// GET /v1/graph (JSON: nodes, links, selection) and GET /v1/positions (binary: where everything is now).
#pragma once

#include "CoreMinimal.h"

/** What a node is: the vault or a drive (sun), a project (star), a folder (planet), a note (moon) ... */
enum class EAetherKind : uint8
{
	Sun,
	Star,
	Planet,
	Moon,
	Ghost,
	Picture,
	Today,
};

struct AETHERBRAIN_API FAetherNode
{
	FString Id;
	FString Title;
	EAetherKind Kind = EAetherKind::Moon;
	/** The colour the brain draws it in (linear). */
	FLinearColor Color = FLinearColor::White;
	/** Radius in the brain's own units. */
	float Radius = 1.f;
	/** Index of its structural parent (the star of a planet, the planet of a moon), INDEX_NONE for none. */
	int32 Parent = INDEX_NONE;
};

struct AETHERBRAIN_API FAetherGraph
{
	uint32 Version = 0;
	FString Vault;
	/** constellation, orbit or system */
	FString Layout;
	TArray<FAetherNode> Nodes;
	/** Links as pairs of node indices. */
	TArray<int32> Edges;
	int32 Selected = INDEX_NONE;
};

/** An orbit ring of the system layout: a circle of Radius in the XZ plane, turned by Rotation, around node Parent (brain space). */
struct AETHERBRAIN_API FAetherRing
{
	int32 Parent = INDEX_NONE;
	float Radius = 0.f;
	FQuat Rotation = FQuat::Identity;
};

struct AETHERBRAIN_API FAetherPositions
{
	uint32 Version = 0;
	/** Brain space (three.js: Y up, right-handed), brain units. */
	TArray<FVector> Points;
	TArray<FAetherRing> Rings;
};

/** The address and token of the companion link. */
struct AETHERBRAIN_API FAetherConnection
{
	FString Url;
	FString Token;
	/** Where they came from (companion.json, the command line, the actor's settings). */
	FString Source;

	bool IsValid() const { return !Url.IsEmpty() && !Token.IsEmpty(); }
};

namespace AetherScene
{
	/** Parses /v1/graph. False (Out unchanged) for anything malformed. */
	AETHERBRAIN_API bool ParseGraph(const FString& Json, FAetherGraph& Out);

	/** Parses /v1/positions: the "AEP1" header, xyz per node, 6 floats per ring. False for anything malformed. */
	AETHERBRAIN_API bool ParsePositions(const TArray<uint8>& Bytes, FAetherPositions& Out);

	/** Brain space (Y up, right-handed) to Unreal space (Z up, left-handed, cm): swap Y and Z, then scale. */
	inline FVector ToUnreal(const FVector& Brain, float Scale)
	{
		return FVector(Brain.X, Brain.Z, Brain.Y) * static_cast<double>(Scale);
	}

	/** A point of ring R at angle T (radians), around the brain-space centre C, in brain space. */
	AETHERBRAIN_API FVector RingPoint(const FAetherRing& R, const FVector& C, float T);

	/** companion.json, written by the desktop app while its companion link runs: every place it can be. */
	AETHERBRAIN_API TArray<FString> ConnectionFileCandidates();

	/** Reads the first companion.json found. */
	AETHERBRAIN_API bool ReadConnectionFile(FAetherConnection& Out);

	/** -AetherUrl=http://127.0.0.1:7459 -AetherToken=... on the command line. */
	AETHERBRAIN_API bool ReadCommandLine(FAetherConnection& Out);
}
