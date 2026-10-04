// Stand-in for the brain actor: the space actor asks it for bounds and tells it about its built-in stars.
#pragma once
#include "UEStubs.h"

class AAetherBrainActor : public AActor
{
public:
	FVector BoundsCenter{100.0, -50.0, 20.0};
	float BoundsRadius = 3000.f;
	bool bHasBounds = true;
	bool bStarsOn = true;
	int StarCalls = 0;
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
};
