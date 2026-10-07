// A stand-in for the slice of Unreal Engine that AetherSpaceActor.cpp uses, so the real source can be compiled and run on an
// ordinary computer (see ../actor_harness.cpp). The shapes follow Unreal 5's API as the plugin uses it; nothing here is
// Unreal. Fake components record what they are given so the harness can check it.
#pragma once

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

using int32 = int32_t;
using uint32 = uint32_t;
using uint8 = uint8_t;
using SIZE_T = size_t;
using TCHAR = char;

#define TEXT(x) x
#define UCLASS(...)
#define USTRUCT(...)
#define UENUM(...)
#define UPROPERTY(...)
#define GENERATED_BODY() public: using Super = AActor;
#define AETHERBRAIN_API
#define INDEX_NONE (-1)
#define THIRD_PARTY_INCLUDES_START
#define THIRD_PARTY_INCLUDES_END
#define UE_LOG(Category, Verbosity, Format, ...) ((void)0)

constexpr uint32 LOAD_Quiet = 0x2000;
constexpr uint32 LOAD_NoWarn = 0x0100;
constexpr uint32 LOCK_READ_WRITE = 2;

template <class T>
T&& MoveTemp(T& V)
{
	return static_cast<T&&>(V);
}

template <class T>
using TObjectPtr = T*;

/* ---- math -------------------------------------------------------------------------------------------------- */

struct FVector
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;
	FVector() = default;
	FVector(double InX, double InY, double InZ) : X(InX), Y(InY), Z(InZ) {}
	explicit FVector(double V) : X(V), Y(V), Z(V) {}
	static const FVector ZeroVector;
};
inline const FVector FVector::ZeroVector = FVector(0.0, 0.0, 0.0);

struct FQuat
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;
	double W = 1.0;
	FQuat() = default;
	FQuat(double InX, double InY, double InZ, double InW) : X(InX), Y(InY), Z(InZ), W(InW) {}
	static const FQuat Identity;
};
inline const FQuat FQuat::Identity = FQuat(0.0, 0.0, 0.0, 1.0);

struct FRotator
{
	double Pitch = 0.0;
	double Yaw = 0.0;
	double Roll = 0.0;
	FRotator() = default;
	FRotator(double InPitch, double InYaw, double InRoll) : Pitch(InPitch), Yaw(InYaw), Roll(InRoll) {}
};

struct FTransform
{
	FQuat Rotation;
	FVector Translation;
	FVector Scale3D{1.0, 1.0, 1.0};
	FTransform() = default;
	FTransform(const FQuat& R, const FVector& T, const FVector& S) : Rotation(R), Translation(T), Scale3D(S) {}
};

struct FLinearColor
{
	float R = 0.f;
	float G = 0.f;
	float B = 0.f;
	float A = 1.f;
	FLinearColor() = default;
	FLinearColor(float InR, float InG, float InB, float InA = 1.f) : R(InR), G(InG), B(InB), A(InA) {}
};

struct FMath
{
	template <class T>
	static T Clamp(T V, T Lo, T Hi) { return V < Lo ? Lo : (V > Hi ? Hi : V); }
	template <class T>
	static T Max(T A, T B) { return A > B ? A : B; }
	static int32 RoundToInt(float F) { return static_cast<int32>(std::floor(F + 0.5f)); }
	static double Exp(double V) { return std::exp(V); }
};

struct FMemory
{
	static void* Memcpy(void* Dest, const void* Src, SIZE_T Count) { return std::memcpy(Dest, Src, Count); }
};

/* ---- containers and pointers ------------------------------------------------------------------------------- */

template <class T>
struct TArray
{
	std::vector<T> V;
	int32 Num() const { return static_cast<int32>(V.size()); }
	T* GetData() { return V.data(); }
	const T* GetData() const { return V.data(); }
	bool IsValidIndex(int32 I) const { return I >= 0 && I < Num(); }
	int32 Add(const T& X) { V.push_back(X); return Num() - 1; }
	int32 Add(T&& X) { V.push_back(std::move(X)); return Num() - 1; }
	void SetNum(int32 N) { V.resize(static_cast<size_t>(N)); }
	void SetNumZeroed(int32 N) { V.resize(static_cast<size_t>(N), T{}); }
	T& operator[](int32 I) { assert(I >= 0 && I < Num()); return V[static_cast<size_t>(I)]; }
	const T& operator[](int32 I) const { assert(I >= 0 && I < Num()); return V[static_cast<size_t>(I)]; }
	T& Last() { return V.back(); }
	typename std::vector<T>::iterator begin() { return V.begin(); }
	typename std::vector<T>::iterator end() { return V.end(); }
	typename std::vector<T>::const_iterator begin() const { return V.begin(); }
	typename std::vector<T>::const_iterator end() const { return V.end(); }
};

template <class T>
using TSharedPtr = std::shared_ptr<T>;
template <class T>
std::shared_ptr<T> MakeShared() { return std::make_shared<T>(); }

class UObject
{
public:
	virtual ~UObject() = default;
	template <class T>
	T* CreateDefaultSubobject(const TCHAR*) { return new T(); }
};

template <class T>
struct TWeakObjectPtr
{
	T* P = nullptr;
	bool IsValid() const { return P != nullptr; }
	T* Get() const { return P; }
	T* operator->() const { return P; }
	TWeakObjectPtr& operator=(T* In) { P = In; return *this; }
};

struct FSoftObjectPath
{
	explicit FSoftObjectPath(const TCHAR*) {}
};

struct FName
{
	std::string S;
	FName(const TCHAR* In) : S(In) {}
};

/** Everything made through NewObject / CreateDefaultSubobject, for the harness to look at. */
inline std::vector<UObject*>& GCreated()
{
	static std::vector<UObject*> V;
	return V;
}

template <class T>
T* NewObject(UObject*)
{
	T* O = new T();
	GCreated().push_back(O);
	return O;
}

template <class T>
T* LoadObject(UObject*, const TCHAR*, const TCHAR* = nullptr, uint32 = 0, UObject* = nullptr) { return nullptr; }

/* ---- assets ------------------------------------------------------------------------------------------------ */

class UMaterialInterface : public UObject
{
public:
	bool bIsFallback = false;
};

class UTexture : public UMaterialInterface
{
};

enum EPixelFormat { PF_B8G8R8A8 };
enum TextureFilter { TF_Bilinear };
enum TextureAddress { TA_Clamp };

struct FByteBulkData
{
	std::vector<uint8> Data;
	void* Lock(uint32) { return Data.data(); }
	void Unlock() {}
};
struct FTexture2DMipMap
{
	FByteBulkData BulkData;
};
struct FTexturePlatformData
{
	TArray<FTexture2DMipMap> Mips;
};

class UTexture2D : public UTexture
{
public:
	bool SRGB = true;
	TextureFilter Filter = TF_Bilinear;
	TextureAddress AddressX = TA_Clamp;
	TextureAddress AddressY = TA_Clamp;
	bool NeverStream = false;
	int Width = 0;
	int Height = 0;
	bool bUpdated = false;
	FTexturePlatformData PlatformData;
	static UTexture2D* CreateTransient(int32 W, int32 H, EPixelFormat = PF_B8G8R8A8)
	{
		UTexture2D* T = new UTexture2D();
		GCreated().push_back(T);
		T->Width = W;
		T->Height = H;
		FTexture2DMipMap Mip;
		Mip.BulkData.Data.assign(static_cast<size_t>(W) * static_cast<size_t>(H) * 4U, 0);
		T->PlatformData.Mips.Add(Mip);
		return T;
	}
	FTexturePlatformData* GetPlatformData() { return &PlatformData; }
	void UpdateResource() { bUpdated = true; }
};

class UMaterialInstanceDynamic : public UMaterialInterface
{
public:
	UMaterialInterface* Parent = nullptr;
	UTexture* Tex = nullptr;
	static UMaterialInstanceDynamic* Create(UMaterialInterface* P, UObject*)
	{
		UMaterialInstanceDynamic* M = new UMaterialInstanceDynamic();
		GCreated().push_back(M);
		M->Parent = P;
		return M;
	}
	void SetTextureParameterValue(FName, UTexture* T) { Tex = T; }
};

class UStaticMesh : public UObject
{
};

namespace ConstructorHelpers
{
template <class T>
struct FObjectFinder
{
	T* Object = nullptr;
	explicit FObjectFinder(const TCHAR*) { Object = new T(); }
};
} // namespace ConstructorHelpers

template <class T>
struct TSoftObjectPtr
{
	T* Loaded = nullptr;
	TSoftObjectPtr() = default;
	explicit TSoftObjectPtr(const FSoftObjectPath&) {}
	T* LoadSynchronous() const { return Loaded; }
};

/* ---- components and actors --------------------------------------------------------------------------------- */

enum class EComponentMobility { Static, Stationary, Movable };
enum class ECollisionEnabled { NoCollision };
enum ETickingGroup { TG_PrePhysics, TG_PostUpdateWork };

class USceneComponent : public UObject
{
public:
	bool bRegistered = false;
	bool bVisible = true;
	FVector WorldLocation;
	FQuat WorldRotation;
	void SetMobility(EComponentMobility) {}
	void SetupAttachment(USceneComponent*) {}
	void SetRelativeRotation(const FRotator&) {}
	void SetWorldLocationAndRotation(FVector L, const FQuat& R, bool = false, void* = nullptr, int = 0) { WorldLocation = L; WorldRotation = R; }
	void SetWorldLocation(FVector L, bool = false, void* = nullptr, int = 0) { WorldLocation = L; }
	void SetVisibility(bool V, bool = false) { bVisible = V; }
	void RegisterComponent() { bRegistered = true; }
};

class UPrimitiveComponent : public USceneComponent
{
public:
	UMaterialInterface* Material = nullptr;
	void SetCollisionEnabled(ECollisionEnabled) {}
	void SetCastShadow(bool) {}
	void SetGenerateOverlapEvents(bool) {}
	void SetMaterial(int32, UMaterialInterface* M) { Material = M; }
};

class UStaticMeshComponent : public UPrimitiveComponent
{
public:
	UStaticMesh* Mesh = nullptr;
	bool SetStaticMesh(UStaticMesh* M) { Mesh = M; return true; }
};

class UInstancedStaticMeshComponent : public UStaticMeshComponent
{
public:
	std::vector<FTransform> Instances;
	std::vector<float> CustomData;
	int32 NumCustom = 0;
	int UpdateCalls = 0;
	int32 AddInstance(const FTransform& T, bool = false)
	{
		assert(bRegistered && NumCustom > 0);
		Instances.push_back(T);
		CustomData.resize(Instances.size() * static_cast<size_t>(NumCustom), 0.f);
		return static_cast<int32>(Instances.size()) - 1;
	}
	bool SetCustomDataValue(int32 I, int32 D, float V, bool = false)
	{
		assert(I >= 0 && static_cast<size_t>(I) < Instances.size() && D >= 0 && D < NumCustom);
		CustomData[static_cast<size_t>(I) * static_cast<size_t>(NumCustom) + static_cast<size_t>(D)] = V;
		return true;
	}
	void SetNumCustomDataFloats(int32 N)
	{
		assert(Instances.empty());
		NumCustom = N;
	}
	void MarkRenderStateDirty() {}
	bool BatchUpdateInstancesTransforms(int32 Start, const TArray<FTransform>& X, bool = false, bool = false, bool = false)
	{
		assert(Start == 0 && static_cast<size_t>(X.Num()) == Instances.size());
		Instances = X.V;
		++UpdateCalls;
		return true;
	}
};

class UDirectionalLightComponent : public USceneComponent
{
public:
	float Intensity = 0.f;
	FLinearColor Color;
	bool bCastShadows = true;
	void SetIntensity(float V) { Intensity = V; }
	void SetLightColor(FLinearColor C, bool = true) { Color = C; }
	void SetCastShadows(bool V) { bCastShadows = V; }
};

struct FActorTickFunction
{
	bool bCanEverTick = false;
	bool bStartWithTickEnabled = false;
	ETickingGroup TickGroup = TG_PrePhysics;
};

class UWorld;

class AActor : public UObject
{
public:
	FActorTickFunction PrimaryActorTick;
	USceneComponent* RootComponent = nullptr;
	FVector Location;
	FVector ForwardDir{1.0, 0.0, 0.0};
	UWorld* WorldPtr = nullptr;
	void SetRootComponent(USceneComponent* R) { RootComponent = R; }
	UWorld* GetWorld() const { return WorldPtr; }
	FVector GetActorLocation() const { return Location; }
	FVector GetActorForwardVector() const { return ForwardDir; }
	virtual void BeginPlay() {}
	virtual void Tick(float) {}
};

class APawn : public AActor
{
};

class APlayerCameraManager : public UObject
{
public:
	FVector GetCameraLocation() const { return FVector(); }
};

class APlayerController : public AActor
{
public:
	APawn* Pawn = nullptr;
	APlayerCameraManager* PlayerCameraManager = nullptr;
	APawn* GetPawn() const { return Pawn; }
};

class UWorld
{
public:
	std::vector<AActor*> Actors;
	APlayerController* Player = nullptr;
	APlayerController* GetFirstPlayerController() const { return Player; }
};

template <class T>
struct TActorIterator
{
	std::vector<T*> Found;
	size_t I = 0;
	explicit TActorIterator(UWorld* W)
	{
		for (AActor* A : W->Actors)
		{
			if (T* Cast = dynamic_cast<T*>(A))
			{
				Found.push_back(Cast);
			}
		}
	}
	explicit operator bool() const { return I < Found.size(); }
	TActorIterator& operator++() { ++I; return *this; }
	T* operator*() const { return Found[I]; }
};
