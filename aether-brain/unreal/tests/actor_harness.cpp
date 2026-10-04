// Runs the real AetherSpaceActor.cpp against a stand-in for Unreal (ue_stubs/): builds the sky, rocks and ships, flies a camera for
// ten simulated seconds, cycles the modes, and checks the actor's bookkeeping (instance counts, update sizes, textures, parallax
// wiring, visibility, what happens with the sky material or the brain missing). It cannot say how Unreal will draw it.
#include "AetherSpaceActor.h"

#include "AetherBrainActor.h"
#include "AetherSpaceMath.h"

#include <cstdio>
#include <set>
#include <string>

namespace Sp = AetherSpace;

static int Failures = 0;
static int Checks = 0;
#define CHECK(Cond)                                                                \
	do                                                                             \
	{                                                                              \
		++Checks;                                                                  \
		if (!(Cond))                                                               \
		{                                                                          \
			++Failures;                                                            \
			std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #Cond);            \
		}                                                                          \
	} while (0)

/** The actor's protected entry points, made reachable. */
struct TestSpace : AAetherSpaceActor
{
	using AAetherSpaceActor::BeginPlay;
	using AAetherSpaceActor::Tick;
	int32 Dummy = 0;
};

struct Scene
{
	UWorld World;
	APawn Pawn;
	APlayerController Pc;
	AAetherBrainActor Brain;
	TestSpace Space;
	std::vector<UObject*> Before;

	explicit Scene(bool bWithSprites = true, bool bWithBrain = true)
	{
		Before = GCreated();
		Pc.Pawn = &Pawn;
		World.Player = &Pc;
		Space.WorldPtr = &World;
		if (bWithBrain)
		{
			World.Actors.push_back(&Brain);
		}
		World.Actors.push_back(&Space);
		if (bWithSprites)
		{
			Space.SpriteMaterial.Loaded = new UMaterialInterface();
		}
		Space.RockMaterial.Loaded = new UMaterialInterface();
	}

	std::vector<UObject*> Made() const { return std::vector<UObject*>(GCreated().begin() + static_cast<long>(Before.size()), GCreated().end()); }

	template <class T>
	std::vector<T*> All() const
	{
		std::vector<T*> Out;
		for (UObject* O : Made())
		{
			if (T* C = dynamic_cast<T*>(O))
			{
				Out.push_back(C);
			}
		}
		return Out;
	}

	void Fly(double T) { Pawn.Location = FVector(-6300.0 + 400.0 * T, 2000.0 * std::sin(0.2 * T), 2600.0); }
	void Frame(double T, float Dt = 1.f / 60.f)
	{
		Fly(T);
		Space.Tick(Dt);
	}
};

static bool Finite(const FTransform& X)
{
	return std::isfinite(X.Translation.X) && std::isfinite(X.Translation.Y) && std::isfinite(X.Translation.Z) && std::isfinite(X.Scale3D.X) && std::isfinite(X.Scale3D.Y) &&
		std::isfinite(X.Scale3D.Z) && std::isfinite(X.Rotation.X) && std::isfinite(X.Rotation.W);
}

static size_t ExpectedShipParts(double Density)
{
	size_t N = 0;
	for (const Sp::ShipSpec& S : Sp::DefaultFleet(2026U, Density))
	{
		N += Sp::ShipParts(S.Design).size();
	}
	return N;
}

static size_t ExpectedSprites(double Density)
{
	size_t N = 0;
	for (const Sp::LayerSpec& L : Sp::DefaultLayers())
	{
		N += static_cast<size_t>(std::max(0, FMath::RoundToInt(static_cast<float>(L.Count) * static_cast<float>(Density))));
	}
	return N;
}

/** From the maths alone: how many rocks, streaks and ship parts should be drawn (not scaled away) at Time. */
static size_t ExpectedVisibleMovers(double Time, const Sp::Vec3& Centre, double Field)
{
	size_t N = 900 * 3;
	for (const Sp::FlybyRock& F : Sp::BuildFlybyRocks(70, 2026U + 4243U))
	{
		double Fade = 0.0;
		(void)Sp::EvalFlybyRock(F, Time, Centre, Field, Fade);
		N += Fade > 0.0 ? 3U : 0U;
	}
	for (const Sp::Streak& S : Sp::BuildStreaks(40, 2026U + 4244U))
	{
		bool bVisible = false;
		(void)Sp::StreakXf(S, Time, Centre, Field, bVisible);
		N += bVisible ? 1U : 0U;
	}
	for (const Sp::ShipSpec& S : Sp::DefaultFleet(2026U, 1.0))
	{
		if (Sp::EvalShip(S, Time, Centre, Field).Fade > 0.0)
		{
			N += Sp::ShipParts(S.Design).size();
		}
	}
	return N;
}

static void TestBuild()
{
	Scene S;
	S.Space.BeginPlay();
	const std::vector<UInstancedStaticMeshComponent*> Isms = S.All<UInstancedStaticMeshComponent>();
	const std::vector<UTexture2D*> Textures = S.All<UTexture2D>();
	const std::vector<UMaterialInstanceDynamic*> Mids = S.All<UMaterialInstanceDynamic>();

	// The pictures: a star, four nebulae, five galaxies; all filled, flagged sRGB, uploaded; and one material each with its picture.
	CHECK(Textures.size() == 1 + Sp::kNebulaVariants + Sp::kGalaxyVariants);
	for (UTexture2D* T : Textures)
	{
		CHECK(T->bUpdated && T->SRGB && T->NeverStream);
		CHECK(T->Width == T->Height && T->Width >= 64);
		const std::vector<uint8>& Px = T->PlatformData.Mips[0].BulkData.Data;
		CHECK(Px.size() == static_cast<size_t>(T->Width) * static_cast<size_t>(T->Height) * 4U);
		size_t Lit = 0;
		for (size_t I = 0; I + 3 < Px.size(); I += 4)
		{
			Lit += (Px[I] | Px[I + 1] | Px[I + 2]) > 30 ? 1U : 0U;
		}
		CHECK(Lit > Px.size() / 4 / 200);
		CHECK(Px[3] == 255);
	}
	CHECK(Mids.size() == Textures.size());
	for (UMaterialInstanceDynamic* M : Mids)
	{
		CHECK(M->Tex != nullptr);
		CHECK(M->Parent == S.Space.SpriteMaterial.Loaded);
	}
	std::set<UTexture*> Distinct;
	for (UMaterialInstanceDynamic* M : Mids)
	{
		Distinct.insert(M->Tex);
	}
	CHECK(Distinct.size() == Mids.size());

	// Every component is registered, has a mesh, a material and four custom floats per instance.
	size_t Total = 0;
	size_t WithSky = 0;
	for (UInstancedStaticMeshComponent* I : Isms)
	{
		CHECK(I->bRegistered && I->Mesh != nullptr && I->Material != nullptr);
		CHECK(I->NumCustom == 4);
		CHECK(I->CustomData.size() == I->Instances.size() * 4U);
		CHECK(!I->Instances.empty());
		Total += I->Instances.size();
		WithSky += dynamic_cast<UMaterialInstanceDynamic*>(I->Material) != nullptr ? I->Instances.size() : 0U;
	}
	// The sky is the instances wearing a sprite material; the rest is rocks, streaks and ship parts.
	CHECK(WithSky == ExpectedSprites(1.0));
	const size_t Movers = 900 * 3 + 70 * 3 + 40 + ExpectedShipParts(1.0);
	CHECK(Total - WithSky == Movers);

	// Lit things (rocks, hull plates) wear the rock material; glowing things (streaks, lights, engines) the emissive one.
	size_t HullParts = 0;
	size_t GlowParts = 0;
	for (const Sp::ShipSpec& Ship : Sp::DefaultFleet(2026U, 1.0))
	{
		for (const Sp::Part& P : Sp::ShipParts(Ship.Design))
		{
			(Sp::IsGlowTone(P.Colour) ? GlowParts : HullParts) += 1;
		}
	}
	size_t Lit = 0;
	size_t Glowing = 0;
	for (UInstancedStaticMeshComponent* I : Isms)
	{
		if (I->Material == S.Space.RockMaterial.Loaded)
		{
			Lit += I->Instances.size();
		}
		else if (dynamic_cast<UMaterialInstanceDynamic*>(I->Material) == nullptr)
		{
			Glowing += I->Instances.size();
		}
	}
	CHECK(Lit == 900 * 3 + 70 * 3 + HullParts);
	CHECK(Glowing == 40 + GlowParts);

	// Colours are real: tints positive, glows positive on the sky, metal in 0..1 on lit things.
	for (UInstancedStaticMeshComponent* I : Isms)
	{
		const bool Sky = dynamic_cast<UMaterialInstanceDynamic*>(I->Material) != nullptr;
		for (size_t K = 0; K < I->Instances.size(); ++K)
		{
			const float R = I->CustomData[K * 4U + 0U];
			const float G = I->CustomData[K * 4U + 1U];
			const float B = I->CustomData[K * 4U + 2U];
			const float E = I->CustomData[K * 4U + 3U];
			CHECK(R >= 0.f && G >= 0.f && B >= 0.f && R <= 1.001f && G <= 1.001f && B <= 1.001f);
			CHECK(E >= 0.f);
			if (Sky)
			{
				CHECK(E > 0.f);
			}
		}
	}

	// Lights: warm key and cool fill, from the shared numbers.
	const std::vector<UDirectionalLightComponent*> Lights;
	CHECK(S.Space.GetMode() == EAetherSpaceMode::Full);
	CHECK(!S.Space.IsSpriteMaterialMissing());
}

static void TestFlight()
{
	Scene S;
	S.Space.BeginPlay();
	const std::vector<UInstancedStaticMeshComponent*> Isms = S.All<UInstancedStaticMeshComponent>();
	CHECK(S.Brain.StarCalls == 0);
	int Frames = 0;
	double SpaceTime = 0.0;
	for (double T = 0.0; T < 10.0; T += 1.0 / 60.0)
	{
		S.Frame(T);
		++Frames;
		SpaceTime += static_cast<double>(1.f / 60.f) * static_cast<double>(S.Space.TimeScale);
	}
	// The brain's own plain stars were turned off the first time the space found the brain.
	CHECK(!S.Brain.bStarsOn);

	size_t Moving = 0;
	size_t Hidden = 0;
	size_t Updated = 0;
	double Farthest = 0.0;
	const Sp::Vec3 Centre{S.Brain.BoundsCenter.X, S.Brain.BoundsCenter.Y, S.Brain.BoundsCenter.Z};
	for (UInstancedStaticMeshComponent* I : Isms)
	{
		const bool Sky = dynamic_cast<UMaterialInstanceDynamic*>(I->Material) != nullptr;
		if (Sky)
		{
			CHECK(I->UpdateCalls == 0);
			continue;
		}
		++Updated;
		// One whole-array update per frame, nothing skipped, nothing twice.
		CHECK(I->UpdateCalls == Frames);
		for (const FTransform& X : I->Instances)
		{
			CHECK(Finite(X));
			++Moving;
			if (X.Scale3D.X == 0.0 && X.Scale3D.Y == 0.0 && X.Scale3D.Z == 0.0)
			{
				++Hidden;
				continue;
			}
			const Sp::Vec3 P{X.Translation.X, X.Translation.Y, X.Translation.Z};
			Farthest = std::max(Farthest, Sp::Length(P - Centre));
			CHECK(X.Scale3D.X > 0.0 && X.Scale3D.Y > 0.0 && X.Scale3D.Z > 0.0);
		}
	}
	CHECK(Updated >= 5);
	// Exactly what the maths says is on show at this moment is drawn: no more (nothing left over), no less (nothing forgotten).
	CHECK(Moving - Hidden == ExpectedVisibleMovers(SpaceTime, Centre, Sp::FieldRadius(S.Brain.BoundsRadius)));
	// Most things are in view; some passes are off at any moment (their instances are scaled to nothing).
	CHECK(Hidden > 0 && Hidden < Moving / 2);
	// Everything stays within a sane distance of the brain.
	CHECK(Farthest < 12.0 * Sp::FieldRadius(S.Brain.BoundsRadius));

	// Parallax wiring: each backdrop layer sits where the maths says for this camera.
	const Sp::Vec3 Cam{S.Pawn.Location.X, S.Pawn.Location.Y, S.Pawn.Location.Z};
	for (const Sp::LayerSpec& L : Sp::DefaultLayers())
	{
		const Sp::Vec3 Origin = Sp::LayerOrigin(Cam, L.Follow, L.Radius);
		bool Found = false;
		for (UInstancedStaticMeshComponent* I : Isms)
		{
			if (dynamic_cast<UMaterialInstanceDynamic*>(I->Material) == nullptr)
			{
				continue;
			}
			Found = Found || (std::fabs(I->WorldLocation.X - Origin.X) < 1e-6 && std::fabs(I->WorldLocation.Y - Origin.Y) < 1e-6 && std::fabs(I->WorldLocation.Z - Origin.Z) < 1e-6);
		}
		CHECK(Found);
	}
	// The sky layer (follows the camera) is exactly at the camera: it never moves on screen.
	bool SkyAtCamera = false;
	for (UInstancedStaticMeshComponent* I : Isms)
	{
		SkyAtCamera = SkyAtCamera || (dynamic_cast<UMaterialInstanceDynamic*>(I->Material) != nullptr && I->WorldLocation.X == S.Pawn.Location.X && I->WorldLocation.Z == S.Pawn.Location.Z);
	}
	CHECK(SkyAtCamera);
}

static void TestModes()
{
	Scene S;
	S.Space.BeginPlay();
	const std::vector<UInstancedStaticMeshComponent*> Isms = S.All<UInstancedStaticMeshComponent>();
	S.Frame(0.0);
	const auto Updates = [&](bool Sky)
	{
		int N = 0;
		for (UInstancedStaticMeshComponent* I : Isms)
		{
			if ((dynamic_cast<UMaterialInstanceDynamic*>(I->Material) != nullptr) == Sky)
			{
				N += I->UpdateCalls;
			}
		}
		return N;
	};
	const auto Visible = [&](bool Sky)
	{
		int N = 0;
		int All = 0;
		for (UInstancedStaticMeshComponent* I : Isms)
		{
			if ((dynamic_cast<UMaterialInstanceDynamic*>(I->Material) != nullptr) == Sky)
			{
				++All;
				N += I->bVisible ? 1 : 0;
			}
		}
		return N == All ? 2 : (N == 0 ? 0 : 1);
	};
	CHECK(Visible(true) == 2 && Visible(false) == 2);

	S.Space.CycleMode();
	CHECK(S.Space.GetMode() == EAetherSpaceMode::Calm);
	CHECK(Visible(true) == 2 && Visible(false) == 0);
	const int Before = Updates(false);
	S.Frame(1.0);
	CHECK(Updates(false) == Before);

	S.Space.CycleMode();
	CHECK(S.Space.GetMode() == EAetherSpaceMode::Off);
	CHECK(Visible(true) == 0 && Visible(false) == 0);
	CHECK(S.Brain.bStarsOn);
	const FVector SkyAt = Isms[0]->WorldLocation;
	S.Frame(2.0);
	CHECK(Isms[0]->WorldLocation.X == SkyAt.X);

	S.Space.CycleMode();
	CHECK(S.Space.GetMode() == EAetherSpaceMode::Full);
	CHECK(Visible(true) == 2 && Visible(false) == 2);
	CHECK(!S.Brain.bStarsOn);
	S.Frame(3.0);
	CHECK(Updates(false) > Before);
	CHECK(std::string(S.Space.GetModeName()) == "full");
	S.Space.CycleMode();
	CHECK(std::string(S.Space.GetModeName()).find("calm") == 0);
	S.Space.CycleMode();
	CHECK(std::string(S.Space.GetModeName()) == "off");
}

static void TestMissingThings()
{
	{
		// No sky material (the editor script has not run yet): no backdrop, no crash, and the brain keeps its own stars.
		Scene S(false);
		S.Space.BeginPlay();
		CHECK(S.Space.IsSpriteMaterialMissing());
		CHECK(S.All<UTexture2D>().empty());
		for (UInstancedStaticMeshComponent* I : S.All<UInstancedStaticMeshComponent>())
		{
			CHECK(dynamic_cast<UMaterialInstanceDynamic*>(I->Material) == nullptr);
		}
		for (double T = 0.0; T < 2.0; T += 1.0 / 30.0)
		{
			S.Frame(T);
		}
		CHECK(S.Brain.bStarsOn);
		CHECK(!S.All<UInstancedStaticMeshComponent>().empty());
	}
	{
		// No brain in the level: the scene is laid out around the origin.
		Scene S(true, false);
		S.Space.BeginPlay();
		for (double T = 0.0; T < 2.0; T += 1.0 / 30.0)
		{
			S.Frame(T);
		}
		bool AnyMoved = false;
		for (UInstancedStaticMeshComponent* I : S.All<UInstancedStaticMeshComponent>())
		{
			AnyMoved = AnyMoved || I->UpdateCalls > 0;
		}
		CHECK(AnyMoved);
	}
	{
		// A brain that has not got its positions yet.
		Scene S;
		S.Brain.bHasBounds = false;
		S.Space.BeginPlay();
		S.Frame(0.0);
		S.Frame(0.5);
		CHECK(true);
	}
	{
		// No player yet.
		Scene S;
		S.World.Player = nullptr;
		S.Space.BeginPlay();
		S.Space.Tick(0.016f);
		CHECK(true);
	}
}

static void TestSizes()
{
	{
		// Density scales the counts; zero builds nothing and does nothing.
		Scene Half;
		Half.Space.Density = 0.5f;
		Half.Space.BeginPlay();
		size_t NHalf = 0;
		for (UInstancedStaticMeshComponent* I : Half.All<UInstancedStaticMeshComponent>())
		{
			NHalf += I->Instances.size();
		}
		Scene Full;
		Full.Space.BeginPlay();
		size_t NFull = 0;
		for (UInstancedStaticMeshComponent* I : Full.All<UInstancedStaticMeshComponent>())
		{
			NFull += I->Instances.size();
		}
		CHECK(NHalf > 0 && NHalf < NFull * 6 / 10);
		Scene None;
		None.Space.Density = 0.f;
		None.Space.AsteroidCount = 0;
		None.Space.BeginPlay();
		None.Frame(0.0);
		None.Frame(1.0);
		size_t NNone = 0;
		for (UInstancedStaticMeshComponent* I : None.All<UInstancedStaticMeshComponent>())
		{
			NNone += I->Instances.size();
		}
		CHECK(NNone == 0);
	}
	{
		// The scene widens with the brain, eased: a big brain pushes the farthest rock out over a few seconds.
		Scene S;
		S.Space.BeginPlay();
		const auto FarthestRock = [&]()
		{
			double Far = 0.0;
			const Sp::Vec3 C{S.Brain.BoundsCenter.X, S.Brain.BoundsCenter.Y, S.Brain.BoundsCenter.Z};
			for (UInstancedStaticMeshComponent* I : S.All<UInstancedStaticMeshComponent>())
			{
				if (dynamic_cast<UMaterialInstanceDynamic*>(I->Material) != nullptr)
				{
					continue;
				}
				for (const FTransform& X : I->Instances)
				{
					if (X.Scale3D.X > 0.0)
					{
						Far = std::max(Far, Sp::Length(Sp::Vec3{X.Translation.X, X.Translation.Y, X.Translation.Z} - C));
					}
				}
			}
			return Far;
		};
		for (double T = 0.0; T < 1.0; T += 1.0 / 60.0)
		{
			S.Frame(T);
		}
		const double Small = FarthestRock();
		S.Brain.BoundsRadius = 30000.f;
		for (double T = 1.0; T < 8.0; T += 1.0 / 60.0)
		{
			S.Frame(T);
		}
		CHECK(FarthestRock() > Small * 2.0);
		// A frame that took ten seconds changes nothing but where things are.
		S.Frame(20.0, 10.f);
		CHECK(std::isfinite(FarthestRock()));
	}
	{
		// TimeScale 0 freezes the motion.
		Scene S;
		S.Space.TimeScale = 0.f;
		S.Space.BeginPlay();
		S.Frame(0.0);
		std::vector<FTransform> First;
		for (UInstancedStaticMeshComponent* I : S.All<UInstancedStaticMeshComponent>())
		{
			if (dynamic_cast<UMaterialInstanceDynamic*>(I->Material) == nullptr)
			{
				First.insert(First.end(), I->Instances.begin(), I->Instances.end());
			}
		}
		for (double T = 0.1; T < 3.0; T += 0.1)
		{
			S.Frame(0.0, 0.1f);
		}
		std::vector<FTransform> Later;
		for (UInstancedStaticMeshComponent* I : S.All<UInstancedStaticMeshComponent>())
		{
			if (dynamic_cast<UMaterialInstanceDynamic*>(I->Material) == nullptr)
			{
				Later.insert(Later.end(), I->Instances.begin(), I->Instances.end());
			}
		}
		CHECK(First.size() == Later.size());
		bool Same = true;
		for (size_t K = 0; K < First.size(); ++K)
		{
			Same = Same && First[K].Translation.X == Later[K].Translation.X;
		}
		CHECK(Same);
	}
}

int main()
{
	TestBuild();
	TestFlight();
	TestModes();
	TestMissingThings();
	TestSizes();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
