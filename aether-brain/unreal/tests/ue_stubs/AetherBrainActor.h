// Stand-in for the brain actor: the space actor asks it for bounds and tells it about its built-in stars; the Niagara layer reads
// its nodes, links, selection and positions (all set by hand in the harness).
#pragma once
#include "UEStubs.h"

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

struct FAetherNode
{
	EAetherKind Kind = EAetherKind::Moon;
	FLinearColor Color{1.f, 1.f, 1.f};
	float Radius = 1.f;
};

class AAetherBrainActor : public AActor
{
public:
	FVector BoundsCenter{100.0, -50.0, 20.0};
	float BoundsRadius = 3000.f;
	bool bHasBounds = true;
	bool bStarsOn = true;
	int StarCalls = 0;

	TArray<FAetherNode> Nodes;
	TArray<FVector> Where;
	TArray<int32> Links;
	uint32 ShapeSerial = 1;
	bool bPositions = false;
	int32 Selected = INDEX_NONE;

	bool GetBounds(FVector& Center, float& Radius) const
	{
		Center = BoundsCenter;
		Radius = BoundsRadius;
		return bHasBounds;
	}
	void SetBuiltInStars(bool bOn)
	{
		bStarsOn = bOn;
		++StarCalls;
	}

	int32 NumNodes() const { return Nodes.Num(); }
	const FAetherNode* GetNode(int32 I) const { return Nodes.IsValidIndex(I) ? &Nodes[I] : nullptr; }
	FVector NodeLocation(int32 I) const { return Where.IsValidIndex(I) ? Where[I] : FVector::ZeroVector; }
	float NodeRadius(int32 I) const
	{
		const FAetherNode* N = GetNode(I);
		return N ? N->Radius * 20.f * (I == Selected ? 1.35f : 1.f) : 0.f;
	}
	const TArray<int32>& GetLinks() const { return Links; }
	uint32 GetShapeSerial() const { return ShapeSerial; }
	bool HasPositions() const { return bPositions; }
	int32 GetSelected() const { return Selected; }
};
