// A stand-in for UNiagaraComponent that records what the Niagara layer does to it: its system, where it was put, the user
// parameters it was given (and which of them as Position or Vector), and a snapshot of all of it each time it was played.
#pragma once
#include "NiagaraSystem.h"
#include "UEStubs.h"

#include <map>
#include <set>
#include <string>

class UNiagaraComponent : public UPrimitiveComponent
{
public:
	/** What the component held at the moment it was played. */
	struct FPlay
	{
		FVector At;
		bool bReset = false;
		std::map<std::string, float> Floats;
		std::map<std::string, FVector> Points;
		std::map<std::string, FLinearColor> Colors;
	};

	UNiagaraSystem* Asset = nullptr;
	bool bAutoActivate = true;
	bool bActive = false;
	int Deactivations = 0;
	std::map<std::string, float> Floats;
	std::map<std::string, FVector> Points;
	std::map<std::string, FLinearColor> Colors;
	/** The names that were set through SetVariablePosition. */
	std::set<std::string> PositionNames;
	std::vector<FPlay> Plays;

	void SetAutoActivate(bool V) { bAutoActivate = V; }
	void SetAsset(UNiagaraSystem* S, bool = true) { Asset = S; }
	void SetVariableFloat(FName Name, float V) { Floats[Name.S] = V; }
	void SetVariableVec3(FName Name, FVector V)
	{
		Points[Name.S] = V;
		PositionNames.erase(Name.S);
	}
	void SetVariablePosition(FName Name, FVector V)
	{
		Points[Name.S] = V;
		PositionNames.insert(Name.S);
	}
	void SetVariableLinearColor(FName Name, const FLinearColor& V) { Colors[Name.S] = V; }
	void Activate(bool bReset = false)
	{
		// The engine refuses to play a component that is not registered.
		assert(bRegistered && Asset != nullptr);
		bActive = true;
		FPlay P;
		P.At = WorldLocation;
		P.bReset = bReset;
		P.Floats = Floats;
		P.Points = Points;
		P.Colors = Colors;
		Plays.push_back(P);
	}
	void Deactivate()
	{
		bActive = false;
		++Deactivations;
	}
};
